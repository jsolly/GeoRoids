// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it as test, vi } from 'vitest';
import { DebugReportWorker } from '../../../server/debugReports/client';
import { readDebugReportConfiguration } from '../../../server/debugReports/configuration';
import { DebugReportStore } from '../../../server/debugReports/store';
import { logger } from '../../../setup/serverLogger';
import type { DebugReportSubmission } from '../../../shared-types';

const directories: string[] = [];
const workers: DebugReportWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await worker.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('isolates storage failure from the caller and leaves valid submissions retryable after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-report-worker-'));
  directories.push(directory);
  const config = {
    path: join(directory, 'inbox.sqlite'),
    token: '',
    projectId: 'project-one',
    sectionId: 'section-one',
  };
  const first = new DebugReportWorker(config);
  workers.push(first);
  const report: DebugReportSubmission = {
    version: 1,
    id: randomUUID(),
    receiptToken: randomBytes(32).toString('hex'),
    description: 'The connection dropped.',
    submittedAt: '2026-10-15T12:00:00.000Z',
    diagnostics: {
      state: {
        version: 1,
        capturedAt: '2026-10-15T12:00:00.000Z',
        sessionId: 'owned-worker-session',
        connected: false,
      },
      recentLogs: [],
    },
  };
  await expect(first.enqueue('{malformed', 'address', {})).rejects.toMatchObject({ status: 400 });
  await expect(
    first.enqueue(JSON.stringify(report), 'address', { connectedPlayers: 3 })
  ).resolves.toEqual({ id: report.id, state: 'blocked' });
  await first.close();
  workers.splice(workers.indexOf(first), 1);
  const reopened = new DebugReportWorker(config);
  workers.push(reopened);
  await expect(reopened.enqueue(JSON.stringify(report), 'address', {})).resolves.toEqual({
    id: report.id,
    state: 'blocked',
  });
  await expect(reopened.status(report.id, report.receiptToken)).resolves.toEqual({
    id: report.id,
    state: 'blocked',
  });
  await expect(reopened.status(report.id, 'different-capability')).resolves.toBeNull();
  expect(reopened.diagnostics().blocked).toBe(1);
  const broken = new DebugReportWorker({ ...config, path: directory });
  workers.push(broken);
  await expect(broken.enqueue(JSON.stringify(report), 'address', {})).rejects.toMatchObject({
    status: 503,
  });
  await expect(reopened.status(report.id, report.receiptToken)).resolves.toMatchObject({
    state: 'blocked',
  });
});

test('cannot silently open production world storage or escape its reviewed volume', () => {
  const env = {
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT_ID: 'owned-environment',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    GEOROIDS_WORLD_PATH: '/data/world.sqlite',
    TODOIST_API_TOKEN: 'reviewed-delivery-token',
  };
  expect(readDebugReportConfiguration(env, 'production')?.path).toBe('/data/debug-reports.sqlite');
  expect(
    readDebugReportConfiguration(
      { ...env, GEOROIDS_DEBUG_REPORTS_PATH: '/data/world.sqlite' },
      'production'
    )
  ).toBeUndefined();
  expect(
    readDebugReportConfiguration(
      { ...env, GEOROIDS_DEBUG_REPORTS_PATH: '/other/reports.sqlite' },
      'production'
    )
  ).toBeUndefined();
  expect(
    readDebugReportConfiguration(
      { ...env, GEOROIDS_DEBUG_REPORTS_PATH: 'relative.sqlite' },
      'production'
    )
  ).toBeUndefined();
  expect(readDebugReportConfiguration({ NODE_ENV: 'test' }, 'development')).toBeUndefined();
  expect(readDebugReportConfiguration({ VITEST: 'true' }, 'development')).toBeUndefined();
  expect(
    readDebugReportConfiguration(
      { VITEST: 'true', GEOROIDS_DEBUG_REPORTS_PATH: '/data/reports.sqlite' },
      'development'
    )
  ).toBeUndefined();
});

test('a missing delivery credential blocks reports rather than refusing to hold them', () => {
  const volume = {
    NODE_ENV: 'production',
    RAILWAY_ENVIRONMENT_ID: 'owned-environment',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    GEOROIDS_WORLD_PATH: '/data/world.sqlite',
  };

  expect(
    readDebugReportConfiguration({ ...volume, TODOIST_API_TOKEN: 'token' }, 'production')?.token
  ).toBe('token');

  // docs/agent-operations.md: "Credential, permission and Todoist
  // project-capacity failures keep reports blocked. Repair the credential or
  // capacity and let the worker retry." So an absent token still configures,
  // and `DebugReportStore` records the report as `blocked`.
  //
  // An earlier revision refused configuration instead, on the premise that
  // accepting was worse because /health would look healthy. That premise was
  // wrong: /health publishes the blocked count, so the queue is visible, and
  // refusing threw away a report the player is then told to keep. It also took
  // out local development's documented `.data` inbox and added a second
  // disable path beside the documented `GEOROIDS_DEBUG_REPORTS_ENABLED=0`.
  expect(readDebugReportConfiguration(volume, 'production')?.token).toBe('');
  expect(
    readDebugReportConfiguration({ ...volume, TODOIST_API_TOKEN: '' }, 'production')?.token
  ).toBe('');

  // The documented switch is still the only way to turn reporting off.
  expect(
    readDebugReportConfiguration(
      { ...volume, TODOIST_API_TOKEN: 'token', GEOROIDS_DEBUG_REPORTS_ENABLED: '0' },
      'production'
    )
  ).toBeUndefined();
});

test('local development keeps its own report inbox without a production credential', () => {
  // AGENTS.md asks for the /debug flow to be smoke-tested locally while saying
  // agents do not configure production credentials, and
  // docs/agent-operations.md gives development its own ignored
  // `.data/debug-reports.sqlite`. Requiring the Todoist secret here made that
  // flow impossible for anyone who does not hold the production account.
  const local = readDebugReportConfiguration(
    { GEOROIDS_DEBUG_REPORTS_PATH: '/tmp/x.sqlite' },
    'development'
  );
  expect(local?.path).toBe('/tmp/x.sqlite');
  expect(local?.token).toBe('');

  // Automated runs stay off, so a developer's own queue is never touched.
  expect(readDebugReportConfiguration({ VITEST: 'true' }, 'development')).toBeUndefined();
  expect(readDebugReportConfiguration({ NODE_ENV: 'test' }, 'development')).toBeUndefined();
});

test('an unmeasured report queue reads as unknown rather than drained', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-report-depth-'));
  directories.push(directory);
  const worker = new DebugReportWorker({
    path: join(directory, 'inbox.sqlite'),
    token: 'token',
    projectId: 'project-depth',
    sectionId: 'section-depth',
  });
  workers.push(worker);

  // Read synchronously, before the worker thread can deliver its first
  // diagnostics message, so this observes the pre-measurement state with no
  // clock or ordering dependence. Zero here would tell an operator that the
  // queue is empty, when nothing has counted it yet. No automated check reads
  // these two fields -- the production smoke receipt fetches /health but
  // asserts only world.* -- so the reader this misleads is a person.
  const depth = worker.diagnostics();
  expect(depth.pending).toBeNull();
  expect(depth.blocked).toBeNull();
  expect(depth.lastError).toBeNull();
});

test('a store that fails after opening publishes an unknown depth and names the cause', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-report-full-'));
  directories.push(directory);
  const faults = vi.spyOn(logger, 'error');
  try {
    // This drives the one shape no other case here reaches: a store that
    // opened, answered, and then started failing. That is the only path into
    // the worker's delivery-tick catch, which produces the fail-closed signal.
    // Without it, reverting that reply to `pending: 0, blocked: 0` or deleting
    // the fault reply outright failed no test anywhere, because every other
    // case supplies its own diagnostics literal.
    //
    // A full database is the lever, driven through the store's own
    // `databaseBytes` limit. Revoking write access would be more direct but
    // cannot work here: the server runs as root, and root bypasses file
    // permission checks entirely.
    const worker = new DebugReportWorker({
      path: join(directory, 'inbox.sqlite'),
      token: '',
      projectId: 'project-full',
      sectionId: 'section-full',
      limits: { databaseBytes: 64 * 1024 },
    });
    workers.push(worker);

    let refusals = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const report: DebugReportSubmission = {
        version: 1,
        id: randomUUID(),
        receiptToken: randomBytes(32).toString('hex'),
        description: 'x'.repeat(2000),
        submittedAt: '2026-10-15T12:00:00.000Z',
        diagnostics: {
          state: {
            version: 1,
            capturedAt: '2026-10-15T12:00:00.000Z',
            sessionId: 'full-store-session',
            connected: false,
          },
          recentLogs: [],
        },
      };
      // A distinct address per submission, so the loop is bounded by the
      // store's size limit and not by the documented three-per-address-per-hour
      // quota. Reusing one address made that quota do the refusing, which is a
      // different rule and would have left the store comfortably empty.
      try {
        await worker.enqueue(JSON.stringify(report), `198.51.100.${attempt}`, {});
      } catch {
        refusals += 1;
      }
    }
    // The store refused some of them, which is its documented behaviour once
    // full and not what this case is about. The cause is asserted below from
    // the fault detail rather than from these refusals: the client-facing
    // message is deliberately generic, so it cannot tell a full store from any
    // other failure.
    expect(refusals).toBeGreaterThan(0);

    await vi.waitFor(
      () => {
        expect(worker.diagnostics().pending).toBeNull();
      },
      { timeout: 10_000 }
    );
    // Null, not zero. Zero is what a regression publishes for a queue nothing
    // has counted, and `/health` would read as drained.
    expect(worker.diagnostics().blocked).toBeNull();
    // `/health` is unauthenticated, so the published string stays generic and
    // carries no path or stack.
    expect(worker.diagnostics().lastError).toBe('Debug report storage is unavailable.');

    // The cause does reach the game thread's log, where an operator can read
    // it. Deleting the worker's fault reply would leave the outage with no
    // recorded cause at all.
    expect(faults).toHaveBeenCalledWith(
      'DEBUG_REPORTS',
      'Debug report storage failed',
      // Naming the mechanism, so this case states why it reaches the fault
      // rather than resting on page arithmetic. Without it the guard could
      // stop guarding -- if a change to the payload or SQLite's page size left
      // the store with room, the fault would never happen and this would be an
      // opaque ten-second timeout inside `npm run gate`. Now it fails saying
      // the store did not fill. The frame is asserted too, because a stack
      // naming the store is the actionable part for an operator and is what
      // distinguishes this record from the generic string on `/health`.
      expect.objectContaining({
        detail: expect.stringMatching(/database or disk is full[\s\S]*DebugReportStore/u),
      })
    );
  } finally {
    faults.mockRestore();
  }
});

test('a report store that could not open serves reports again once a later request replaces its worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-report-recovery-'));
  directories.push(directory);
  const path = join(directory, 'inbox.sqlite');
  // A directory where the database belongs: the thread's store cannot open,
  // which is a real thread-level failure on a real thread. Removing it below
  // is the transient condition clearing, as a remounted volume would.
  mkdirSync(path);
  const worker = new DebugReportWorker({
    path,
    token: '',
    projectId: 'project-recovery',
    sectionId: 'section-recovery',
  });
  workers.push(worker);
  await vi.waitFor(
    () => {
      expect(worker.diagnostics().lastError).toBe(
        'Debug report worker is unavailable. Keep your local copy.'
      );
    },
    { timeout: 10_000 }
  );
  rmSync(path, { recursive: true });

  // Before, this failure closed reporting until the next deploy. Now the next
  // request summons one replacement and is itself refused, because a request
  // never waits for a handover; the player's retry reaches the new thread.
  const report: DebugReportSubmission = {
    version: 1,
    id: randomUUID(),
    receiptToken: randomBytes(32).toString('hex'),
    description: 'The report storage came back.',
    submittedAt: '2026-10-31T12:00:00.000Z',
    diagnostics: {
      state: {
        version: 1,
        capturedAt: '2026-10-31T12:00:00.000Z',
        sessionId: 'recovered-worker-session',
        connected: false,
      },
      recentLogs: [],
    },
  };
  await expect(worker.enqueue(JSON.stringify(report), 'address', {})).rejects.toMatchObject({
    status: 503,
    message: 'Debug report storage is restarting. Keep your local copy and retry.',
  });
  await vi.waitFor(
    () => {
      expect(worker.diagnostics()).toMatchObject({ pending: 0, blocked: 0, lastError: null });
    },
    { timeout: 10_000 }
  );
  await expect(worker.enqueue(JSON.stringify(report), 'address', {})).resolves.toEqual({
    id: report.id,
    state: 'blocked',
  });
  await expect(worker.status(report.id, report.receiptToken)).resolves.toEqual({
    id: report.id,
    state: 'blocked',
  });
});

test('a report thread holds its store exclusively until it exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-report-claim-'));
  directories.push(directory);
  const config = {
    path: join(directory, 'inbox.sqlite'),
    token: '',
    projectId: 'project-claim',
    sectionId: 'section-claim',
  };
  // The production thread module on a real thread, driven directly so this
  // case can terminate it the way a failed request deadline does, without the
  // graceful close that would release the store on its own.
  const thread = new Worker(new URL('../../../server/debugReports/worker.ts', import.meta.url), {
    workerData: config,
    execArgv: ['--import', 'tsx'],
  });
  const exited = once(thread, 'exit');
  try {
    // Its first diagnostics reply means the store is open and has been read.
    await once(thread, 'message');
    // A second connection -- an orphaned or overlapping thread -- cannot claim
    // or deliver a row while this one lives: it cannot even open the store.
    expect(() => new DebugReportStore(config)).toThrow(/database is locked/u);
  } finally {
    await thread.terminate();
    await exited;
  }
  // `exit` is the handover signal `DebugReportWorker` waits for before it
  // constructs a replacement. Termination skipped `close()`, so this proves
  // Node itself released the connection by then.
  const successor = new DebugReportStore(config);
  expect(successor.diagnostics()).toMatchObject({ pending: 0, blocked: 0 });
  successor.close();
});
