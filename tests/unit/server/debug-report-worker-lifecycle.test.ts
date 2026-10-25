// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it as test } from 'vitest';
import { DebugReportWorker } from '../../../server/debugReports/client';
import { readDebugReportConfiguration } from '../../../server/debugReports/configuration';
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
