// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it as test } from 'vitest';
import { readDebugReport } from '../../../scripts/read-debug-report';
import type { DebugReportConfiguration } from '../../../server/debugReports/configuration';
import { DebugReportStore, digest, reportChunks } from '../../../server/debugReports/store';
import { TodoistDelivery } from '../../../server/debugReports/todoist';
import { parseDebugReportSubmission } from '../../../shared/debugReports';
import type { DebugReportSubmission } from '../../../shared-types';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) {
    await release();
  }
});
function configuration(
  overrides: Partial<DebugReportConfiguration> = {}
): DebugReportConfiguration {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-debug-reports-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return {
    path: join(directory, 'reports.sqlite'),
    token: 'server-credential',
    projectId: 'project-one',
    sectionId: 'section-one',
    ...overrides,
  };
}
function submission(): DebugReportSubmission {
  const privateUrl = new URL('https://georoids.com/debug');
  privateUrl.username = 'user';
  privateUrl.password = 'password';
  privateUrl.searchParams.set('token', 'private');
  return {
    version: 1,
    id: randomUUID(),
    receiptToken: randomBytes(32).toString('hex'),
    description: 'Ship controls stopped responding.',
    submittedAt: '2026-10-15T12:00:00.000Z',
    diagnostics: {
      state: {
        version: 1,
        capturedAt: '2026-10-15T12:00:00.000Z',
        sessionId: 'session-1',
        connected: false,
        ship: {
          url: privateUrl.toString(),
          password: 'never-publish',
          detail: 'server-credential',
        },
      },
      recentLogs: [],
    },
  };
}
function unredactableSubmission(): DebugReportSubmission {
  const report = submission();
  return { ...report, diagnostics: { ...report.diagnostics, recentLogs: ['not a log record'] } };
}
function store(config: DebugReportConfiguration): DebugReportStore {
  const value = new DebugReportStore(config);
  cleanup.push(() => value.close());
  return value;
}

describe('debug report acceptance is durable and bounded', () => {
  test('keeps one immutable report across lost acknowledgements and process restarts', () => {
    const config = configuration();
    const report = submission();
    const first = new DebugReportStore(config);
    expect(first.accept(report, 'owned-address', { players: 2 }, 1_800_000_000_000)).toEqual({
      id: report.id,
      state: 'pending',
    });
    first.close();
    const reopened = store(config);
    expect(reopened.accept(report, 'different-address', { players: 9 }, 1_800_000_000_001)).toEqual(
      { id: report.id, state: 'pending' }
    );
    expect(reopened.diagnostics().pending).toBe(1);
    expect(reopened.status(report.id, 'wrong-capability')).toBeNull();
    expect(reopened.status(report.id, report.receiptToken)?.id).toBe(report.id);
    expect(() =>
      reopened.accept({ ...report, description: 'changed after saving' }, 'owned-address', {})
    ).toThrow('already used');
    const saved = reopened.next(1_800_000_000_002);
    expect(saved?.bundle).toContain('[redacted]');
    expect(saved?.bundle).not.toContain('never-publish');
    expect(saved?.bundle).not.toContain('server-credential');
    expect(saved?.bundle).not.toContain('user:password');
    expect(saved?.bundle).not.toContain('?token=');
    expect(saved?.bundle).not.toContain(report.receiptToken);
    expect(saved?.integrityHash).toBe(digest(saved?.bundle ?? ''));
    reopened.delivered(report.id);
    expect(reopened.next()).toBeNull();
    expect(reopened.accept(report, 'owned-address', {})).toEqual({
      id: report.id,
      state: 'delivered',
    });
  });

  test('counts only new accepted reports and preserves the per-address limit across restart', () => {
    const config = configuration();
    const db = new DebugReportStore(config);
    const first = submission();
    const now = 1_800_000_000_000;
    db.accept(first, 'pilot', {}, now);
    for (let count = 0; count < 5; count++) {
      db.accept(first, 'pilot', {}, now);
    }
    db.accept(submission(), 'pilot', {}, now);
    db.accept(submission(), 'pilot', {}, now);
    db.close();
    const reopened = store(config);
    expect(() => reopened.accept(submission(), 'pilot', {}, now)).toThrow('limit reached');
    expect(reopened.accept(first, 'pilot', {}, now)).toEqual({ id: first.id, state: 'pending' });
    // Redaction cannot parse this log line, so the error names the stage that ran:
    // a limited address is refused before its diagnostics are touched.
    const unredactable = unredactableSubmission();
    expect(() => reopened.accept(unredactable, 'pilot', {}, now)).toThrow('limit reached');
    expect(() => reopened.accept(unredactable, 'other-pilot', {}, now)).toThrow(SyntaxError);
    expect(reopened.diagnostics().pending).toBe(3);
    expect(reopened.accept(submission(), 'pilot', {}, now + 3_600_000).state).toBe('pending');
  });

  test('retains existing pending reports when global limits or storage headroom reject new ones', () => {
    const db = store(configuration());
    const now = 1_800_000_000_000;
    for (let count = 0; count < 30; count++) {
      db.accept(submission(), `address-${count}`, {}, now);
    }
    expect(() => db.accept(submission(), 'address-31', {}, now)).toThrow('limit reached');
    expect(() => db.accept(unredactableSubmission(), 'address-32', {}, now)).toThrow(
      'limit reached'
    );
    expect(db.diagnostics().pending).toBe(30);
    const full = store(configuration({ limits: { pendingCount: 3 } }));
    for (let count = 0; count < 3; count++) {
      full.accept(submission(), 'pilot', {}, now);
    }
    expect(() => full.accept(submission(), 'other', {}, now)).toThrow('storage is full');
    // A limited address is told it is limited, not that storage is full.
    expect(() => full.accept(submission(), 'pilot', {}, now)).toThrow('limit reached');
    expect(full.diagnostics().pending).toBe(3);
    const noSpace = store(configuration({ limits: { minimumFreeBytes: Number.MAX_SAFE_INTEGER } }));
    expect(() => noSpace.accept(submission(), 'pilot', {})).toThrow('Insufficient space');
    expect(noSpace.diagnostics().pending).toBe(0);
  });

  test('a slash-heavy upload at the size limits is saved with its long string clipped', () => {
    const db = store(configuration());
    const report = submission();
    // Slashes were the quadratic case for both former query patterns. The cost
    // of this shape is bounded in debug-reports-redact-text-and-preserve-evidence.
    const line = JSON.stringify({
      version: 1,
      source: 'client',
      level: 'error',
      timestamp: '2026-10-15T12:00:00.000Z',
      message: '/'.repeat(8_000),
    });
    const body = JSON.stringify({
      ...report,
      diagnostics: {
        state: { ...report.diagnostics.state, browser: '/'.repeat(150_000) },
        recentLogs: Array.from({ length: 80 }, () => line),
      },
    });
    const parsed = parseDebugReportSubmission(JSON.parse(body));
    expect(db.accept(parsed, 'pilot', {}, 1_800_000_000_000).state).toBe('pending');
    const saved: unknown = JSON.parse(db.next(1_800_000_000_001)?.bundle ?? 'null');
    expect(saved).toMatchObject({
      diagnostics: { state: { browser: `${'/'.repeat(8180)}…[truncated]` } },
    });
  });

  test('stores reports while credentials are missing and never splits Unicode surrogate pairs', () => {
    const db = store(configuration({ token: '' }));
    const report = submission();
    expect(db.accept(report, 'pilot', {}).state).toBe('blocked');
    const bundle = '🚀é'.repeat(18_000);
    const chunks = reportChunks(bundle, report.id);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 12_000)).toBe(true);
    expect(chunks.map((chunk) => chunk.slice(chunk.indexOf('\n') + 1)).join('')).toBe(bundle);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
  });
});

interface FakeTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string;
  checked?: boolean;
  is_deleted?: boolean;
  completed_at?: string;
}
interface FakeComment {
  id: string;
  content: string;
}
interface FakeTodoist {
  origin: string;
  tasks: FakeTask[];
  comments: FakeComment[];
  loseCreateResponse: boolean;
  failCommentOnce: boolean;
  accountEmail: string;
  rateLimitOnce: number;
  syncErrorOnce: Record<string, unknown> | null;
  commandCalls: Map<string, number>;
}
async function fakeTodoist(): Promise<FakeTodoist> {
  const state: FakeTodoist = {
    origin: '',
    tasks: [],
    comments: [],
    loseCreateResponse: false,
    failCommentOnce: false,
    accountEmail: 'todoist@jsolly.com',
    rateLimitOnce: 0,
    syncErrorOnce: null,
    commandCalls: new Map(),
  };
  const outcomes = new Map<string, { status: unknown; tempId: string; resourceId: string }>();
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (value: unknown): void => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== 'Bearer server-credential') {
      response.statusCode = 401;
      send({});
      return;
    }
    if (url.pathname.endsWith('/user')) {
      send({ id: '17333018', email: state.accountEmail });
      return;
    }
    if (url.pathname.includes('/projects/')) {
      send({ id: 'project-one', is_archived: false });
      return;
    }
    if (url.pathname.includes('/sections/')) {
      send({ id: 'section-one', project_id: 'project-one', name: 'Debug reports' });
      return;
    }
    if (url.pathname.endsWith('/tasks')) {
      send({ results: state.tasks, next_cursor: null });
      return;
    }
    if (url.pathname.includes('/tasks/')) {
      send(state.tasks.find((task) => task.id === url.pathname.split('/').at(-1)) ?? {});
      return;
    }
    if (url.pathname.endsWith('/comments')) {
      // Exercise pagination even for a small fixture, not just a single-page success.
      const page = Number(url.searchParams.get('cursor') ?? '0');
      send({
        results: state.comments.slice(page, page + 1),
        next_cursor: page + 1 < state.comments.length ? String(page + 1) : null,
      });
      return;
    }
    if (url.pathname.endsWith('/sync')) {
      if (state.rateLimitOnce > 0) {
        response.statusCode = 429;
        response.setHeader('Retry-After', String(state.rateLimitOnce));
        state.rateLimitOnce = 0;
        send({});
        return;
      }
      let body = '';
      for await (const part of request) {
        body += String(part);
      }
      const parsed: unknown = JSON.parse(new URLSearchParams(body).get('commands') ?? '[]');
      if (!Array.isArray(parsed)) {
        response.statusCode = 400;
        send({});
        return;
      }
      const statuses: Record<string, unknown> = {};
      const mappings: Record<string, string> = {};
      let created = false;
      for (const value of parsed) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('uuid' in value) ||
          typeof value.uuid !== 'string' ||
          !('temp_id' in value) ||
          typeof value.temp_id !== 'string' ||
          !('type' in value) ||
          !('args' in value) ||
          typeof value.args !== 'object' ||
          value.args === null
        ) {
          throw new Error('Invalid test command');
        }
        if (state.syncErrorOnce !== null) {
          const error = state.syncErrorOnce;
          state.syncErrorOnce = null;
          send({ sync_status: { [value.uuid]: error }, temp_id_mapping: {} });
          return;
        }
        state.commandCalls.set(value.uuid, (state.commandCalls.get(value.uuid) ?? 0) + 1);
        const previous = outcomes.get(value.uuid);
        if (previous) {
          statuses[value.uuid] = previous.status;
          mappings[previous.tempId] = previous.resourceId;
          continue;
        }
        const args = value.args;
        if (value.type === 'note_add' && state.failCommentOnce) {
          state.failCommentOnce = false;
          statuses[value.uuid] = { http_code: 503 };
          continue;
        }
        let resource = '';
        if (value.type === 'item_add') {
          if (
            !('content' in args) ||
            typeof args.content !== 'string' ||
            !('description' in args) ||
            typeof args.description !== 'string'
          ) {
            throw new Error('Missing task fields');
          }
          resource = `task-${state.tasks.length + 1}`;
          state.tasks.push({
            id: resource,
            content: args.content,
            description: args.description,
            project_id: 'project-one',
            section_id: 'section-one',
          });
          created = true;
        } else if (value.type === 'note_add') {
          if (
            !('content' in args) ||
            typeof args.content !== 'string' ||
            !('uids_to_notify' in args) ||
            !Array.isArray(args.uids_to_notify) ||
            args.uids_to_notify.length !== 0
          ) {
            throw new Error('Comments must suppress notifications');
          }
          resource = `comment-${state.comments.length + 1}`;
          state.comments.push({ id: resource, content: args.content });
        } else if (value.type === 'item_update') {
          if (
            !('id' in args) ||
            !('content' in args) ||
            typeof args.content !== 'string' ||
            !('description' in args) ||
            typeof args.description !== 'string'
          ) {
            throw new Error('Invalid update fields');
          }
          const task = state.tasks.find((entry) => entry.id === args.id);
          if (!task) {
            throw new Error('Missing actual task ID');
          }
          task.content = args.content;
          task.description = args.description;
          resource = task.id;
        }
        statuses[value.uuid] = 'ok';
        mappings[value.temp_id] = resource;
        outcomes.set(value.uuid, { status: 'ok', tempId: value.temp_id, resourceId: resource });
      }
      if (created && state.loseCreateResponse) {
        state.loseCreateResponse = false;
        response.destroy();
        return;
      }
      send({ sync_status: statuses, temp_id_mapping: mappings });
      return;
    }
    response.statusCode = 404;
    send({});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected owned loopback server');
  }
  state.origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return state;
}

describe('Todoist delivery reconciles real HTTP responses with the durable queue', () => {
  test('recovers after task creation acknowledgement loss and partial comments without duplicates', async () => {
    const remote = await fakeTodoist();
    const config = configuration({ testApiOrigin: remote.origin });
    const report = submission();
    report.diagnostics.state['ship'] = { text: '🚀é'.repeat(15_000) };
    const db = new DebugReportStore(config);
    db.accept(report, 'pilot', {});
    const first = db.next();
    if (!first) {
      throw new Error('Expected durable report');
    }
    remote.loseCreateResponse = true;
    await expect(new TodoistDelivery(config).deliver(first, db)).rejects.toThrow();
    expect(remote.tasks).toHaveLength(1);
    db.close();
    const reopened = store(config);
    const retry = reopened.next();
    if (!retry) {
      throw new Error('Expected report after restart');
    }
    remote.failCommentOnce = true;
    await expect(new TodoistDelivery(config).deliver(retry, reopened)).rejects.toThrow('rejected');
    expect(reopened.status(report.id, report.receiptToken)?.state).toBe('pending');
    expect(remote.tasks[0]?.content).toContain('delivery incomplete');
    const finalRetry = reopened.next();
    if (!finalRetry) {
      throw new Error('Expected incomplete report');
    }
    await new TodoistDelivery(config).deliver(finalRetry, reopened);
    expect(remote.tasks).toHaveLength(1);
    expect(remote.tasks[0]?.content).toContain('verified ready');
    expect(reopened.status(report.id, report.receiptToken)?.state).toBe('delivered');
    const reconstructed = remote.comments
      .map((comment) => {
        const header = comment.content.slice(0, comment.content.indexOf('\n'));
        return {
          index: Number(header.split(' ').at(-1)?.split('/')[0]),
          data: comment.content.slice(comment.content.indexOf('\n') + 1),
        };
      })
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.data)
      .join('');
    expect(digest(reconstructed)).toBe(first.integrityHash);
    expect(Buffer.byteLength(reconstructed)).toBe(Buffer.byteLength(first.bundle));
    expect(new Set(remote.comments.map((comment) => comment.content)).size).toBe(
      remote.comments.length
    );
  });

  test.each([
    { failure: 'http-rate-limit', blocked: false, milliseconds: 70_000 },
    { failure: 'sync-rate-limit', blocked: false, milliseconds: 90_000 },
    { failure: 'sync-capacity', blocked: true, milliseconds: 120_000 },
  ])(
    'preserves $failure backoff and retains the report',
    async ({ failure, blocked, milliseconds }) => {
      const remote = await fakeTodoist();
      if (failure === 'http-rate-limit') {
        remote.rateLimitOnce = 70;
      } else {
        remote.syncErrorOnce = {
          ...(failure === 'sync-rate-limit' ? { http_code: 429 } : {}),
          error_tag: failure === 'sync-capacity' ? 'PROJECT_TASK_LIMIT' : 'TOO_MANY_REQUESTS',
          error_extra: { retry_after: milliseconds / 1000 },
        };
      }
      const config = configuration({ testApiOrigin: remote.origin });
      const db = store(config);
      const report = submission();
      db.accept(report, 'pilot', {});
      const saved = db.next();
      if (!saved) {
        throw new Error('Expected pending report');
      }
      await expect(new TodoistDelivery(config).deliver(saved, db)).rejects.toMatchObject({
        blocked,
        retryAfterMs: milliseconds,
      });
      expect(remote.tasks).toHaveLength(0);
      expect(db.status(report.id, report.receiptToken)?.state).toBe('pending');
    }
  );

  test.each([
    { checked: true },
    { is_deleted: true },
    { completed_at: '2026-10-15T12:01:00.000Z' },
  ])('stops delivering when the task is no longer open: %j', async (closedFields) => {
    const remote = await fakeTodoist();
    const config = configuration({ testApiOrigin: remote.origin });
    const db = store(config);
    const report = submission();
    db.accept(report, 'pilot', {});
    const saved = db.next();
    if (!saved) {
      throw new Error('Expected pending report');
    }
    remote.failCommentOnce = true;
    await expect(new TodoistDelivery(config).deliver(saved, db)).rejects.toThrow('rejected');
    const task = remote.tasks[0];
    if (!task) {
      throw new Error('Expected durable task creation');
    }
    Object.assign(task, closedFields);
    const retry = db.next();
    if (!retry) {
      throw new Error('Expected retained report');
    }
    await expect(new TodoistDelivery(config).deliver(retry, db)).rejects.toMatchObject({
      blocked: true,
    });
    expect(remote.comments).toHaveLength(0);
    expect(task.content).toContain('delivery incomplete');
    expect(db.status(report.id, report.receiptToken)?.state).toBe('pending');
  });

  test('preserves quoted delivery markers in visitor prose while publishing the canonical ready footer', async () => {
    const remote = await fakeTodoist();
    const config = configuration({ testApiOrigin: remote.origin });
    const db = store(config);
    const report = submission();
    const quotedId = randomUUID();
    report.description = `I copied an older report below.\n\nReport: ${quotedId}\nBundle: 9 bytes, SHA-256 ${'a'.repeat(64)}\nDelivery incomplete. Do not triage until the verified-ready marker appears.\nPlease investigate the connection drop.`;
    db.accept(report, 'pilot', {});
    const saved = db.next();
    if (!saved) {
      throw new Error('Expected durable report');
    }
    await new TodoistDelivery(config).deliver(saved, db);
    const task = remote.tasks[0];
    if (!task) {
      throw new Error('Expected delivered task');
    }
    expect(task.description).toContain(report.description);
    const footer = task.description.slice(task.description.lastIndexOf('\n\nReport: ') + 2);
    expect(footer).toContain(`Report: ${report.id}`);
    expect(footer).toContain(
      'VERIFIED READY: all numbered comments were reread and matched the bundle hash and size.'
    );
    expect(footer).not.toContain('Delivery incomplete.');
    expect(readDebugReport({ description: task.description, comments: remote.comments })).toEqual(
      JSON.parse(saved.bundle)
    );
    expect(db.status(report.id, report.receiptToken)?.state).toBe('delivered');
  });

  test('refuses to send diagnostic content to a mismatched account', async () => {
    const remote = await fakeTodoist();
    remote.accountEmail = 'someone-else@example.com';
    const config = configuration({ testApiOrigin: remote.origin });
    const db = store(config);
    const report = submission();
    db.accept(report, 'pilot', {});
    const saved = db.next();
    if (!saved) {
      throw new Error('Expected pending report');
    }
    await expect(new TodoistDelivery(config).deliver(saved, db)).rejects.toThrow('does not match');
    expect(remote.tasks).toHaveLength(0);
    expect(remote.comments).toHaveLength(0);
    expect(db.status(report.id, report.receiptToken)?.state).toBe('pending');
  });
});
