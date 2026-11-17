import type { DebugReportConfiguration } from './configuration';
import {
  type DebugReportStore,
  type DeliveryCommand,
  digest,
  reportChunks,
  type StoredReport,
} from './store';

export class TodoistDeliveryError extends Error {
  constructor(
    message: string,
    readonly blocked: boolean,
    readonly retryAfterMs = 0
  ) {
    super(message);
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function resourceId(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}
function invalidResponse(): never {
  throw new TodoistDeliveryError('Todoist returned an invalid response.', false);
}
function apiOrigin(config: DebugReportConfiguration): string {
  if (config.testApiOrigin === undefined || config.testApiOrigin === '') {
    return 'https://api.todoist.com';
  }
  const url = new URL(config.testApiOrigin);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Test Todoist origin must be a loopback HTTP origin');
  }
  return url.origin;
}

/** Fixed destination, persisted command identities, and reread verification before readiness. */
export class TodoistDelivery {
  private readonly origin: string;
  constructor(private readonly config: DebugReportConfiguration) {
    this.origin = apiOrigin(config);
  }

  private async request(path: string, commands?: DeliveryCommand[]): Promise<unknown> {
    const response = await fetch(new URL(path, new URL('/api/v1/', this.origin)), {
      method: commands ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(commands ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(commands ? { body: new URLSearchParams({ commands: JSON.stringify(commands) }) } : {}),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get('retry-after');
      const seconds = retry === null ? Number.NaN : Number(retry);
      const retryAfterMs =
        retry === null
          ? 0
          : Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : Math.max(0, Date.parse(retry) - Date.now()) || 0;
      throw new TodoistDeliveryError(
        `Todoist delivery returned HTTP ${response.status}.`,
        [400, 401, 403, 404, 409].includes(response.status),
        retryAfterMs
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      invalidResponse();
    }
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        await reader.cancel();
        invalidResponse();
      }
      parts.push(result.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }

  private async verifyDestination(): Promise<void> {
    if (!this.config.token || !this.config.sectionId) {
      throw new TodoistDeliveryError(
        'Todoist credentials or Debug reports section are not configured.',
        true
      );
    }
    const user = await this.request('user');
    if (
      !record(user) ||
      resourceId(user['id']) !== '17333018' ||
      user['email'] !== 'todoist@jsolly.com'
    ) {
      throw new TodoistDeliveryError(
        'Todoist account does not match the configured report owner.',
        true
      );
    }
    const project = await this.request(`projects/${encodeURIComponent(this.config.projectId)}`);
    if (
      !record(project) ||
      resourceId(project['id']) !== this.config.projectId ||
      project['is_archived'] === true
    ) {
      throw new TodoistDeliveryError('Todoist report project is unavailable.', true);
    }
    const section = await this.request(`sections/${encodeURIComponent(this.config.sectionId)}`);
    if (
      !record(section) ||
      resourceId(section['id']) !== this.config.sectionId ||
      resourceId(section['project_id']) !== this.config.projectId ||
      section['is_archived'] === true
    ) {
      throw new TodoistDeliveryError(
        'Todoist Debug reports section does not match its project.',
        true
      );
    }
  }

  private async pages(path: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = await this.request(
        `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      );
      if (!record(response) || !Array.isArray(response['results'])) {
        invalidResponse();
      }
      for (const entry of response['results']) {
        if (!record(entry)) {
          invalidResponse();
        }
        results.push(entry);
      }
      const next = response['next_cursor'];
      if (next !== null && typeof next !== 'string') {
        invalidResponse();
      }
      cursor = next;
      if (cursor) {
        if (seen.has(cursor) || seen.size >= 1000) {
          invalidResponse();
        }
        seen.add(cursor);
      }
    } while (cursor);
    return results;
  }

  private async sync(commands: DeliveryCommand[]): Promise<Record<string, unknown>> {
    const response = await this.request('sync', commands);
    if (!record(response) || !record(response['sync_status'])) {
      invalidResponse();
    }
    const statuses = response['sync_status'];
    for (const command of commands) {
      const status = statuses[command.uuid];
      if (status !== 'ok') {
        if (!record(status)) {
          invalidResponse();
        }
        const code = typeof status['http_code'] === 'number' ? status['http_code'] : 0;
        const extra = status['error_extra'];
        const retryAfter = record(extra) ? extra['retry_after'] : undefined;
        const retryAfterMs =
          typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
            ? retryAfter * 1000
            : 0;
        throw new TodoistDeliveryError(
          'Todoist rejected a report delivery command.',
          code !== 429 && !(code >= 500 && code < 600),
          retryAfterMs
        );
      }
    }
    const mappings = response['temp_id_mapping'];
    return record(mappings) ? mappings : {};
  }

  private async reconcileTask(report: StoredReport): Promise<string | null> {
    const tasks = await this.pages(
      `tasks?project_id=${encodeURIComponent(this.config.projectId)}&limit=100`
    );
    const matches = tasks.filter(
      (task) =>
        typeof task['content'] === 'string' &&
        task['content'].startsWith(`Debug report ${report.id} —`) &&
        resourceId(task['section_id']) === this.config.sectionId
    );
    if (matches.length > 1) {
      throw new TodoistDeliveryError(
        'Multiple Todoist tasks match this report; reconciliation needs review.',
        true
      );
    }
    const match = matches[0];
    return match ? resourceId(match['id']) : null;
  }

  private async openTask(taskId: string): Promise<Record<string, unknown>> {
    const task = await this.request(`tasks/${encodeURIComponent(taskId)}`);
    if (
      !record(task) ||
      resourceId(task['id']) !== taskId ||
      resourceId(task['project_id']) !== this.config.projectId ||
      resourceId(task['section_id']) !== this.config.sectionId ||
      task['checked'] === true ||
      task['is_deleted'] === true ||
      task['is_completed'] === true ||
      (typeof task['completed_at'] === 'string' && task['completed_at'] !== '')
    ) {
      throw new TodoistDeliveryError(
        'The report task was moved, deleted, or closed before delivery completed.',
        true
      );
    }
    return task;
  }

  async deliver(report: StoredReport, store: DebugReportStore): Promise<void> {
    await this.verifyDestination();
    const create = report.commands[0];
    const ready = report.commands.at(-1);
    if (create?.type !== 'item_add' || !ready || ready.type !== 'item_update') {
      throw new Error('Missing persisted report commands');
    }
    let taskId = report.taskId ?? (await this.reconcileTask(report));
    if (taskId === null || taskId === '') {
      const mappings = await this.sync([create]);
      taskId = resourceId(mappings[create.temp_id]) ?? (await this.reconcileTask(report));
      if (taskId === null || taskId === '') {
        throw new TodoistDeliveryError('Todoist task creation needs reconciliation.', false);
      }
    }
    // Persist before posting any comment. A restart never needs a temporary task ID again.
    store.saveTask(report.id, taskId);
    await this.openTask(taskId);
    const existing = await this.pages(`comments?task_id=${encodeURIComponent(taskId)}&limit=100`);
    const missing: DeliveryCommand[] = [];
    for (const saved of report.commands.slice(1, -1)) {
      if (!existing.some((comment) => comment['content'] === saved.args['content'])) {
        missing.push({ ...saved, args: { ...saved.args, item_id: taskId } });
      }
    }
    for (let offset = 0; offset < missing.length; offset += 10) {
      await this.openTask(taskId);
      await this.sync(missing.slice(offset, offset + 10));
    }
    const comments = await this.pages(`comments?task_id=${encodeURIComponent(taskId)}&limit=100`);
    const expectedChunks = reportChunks(report.bundle, report.id);
    const diagnosticComments = comments.filter(
      (comment) =>
        typeof comment['content'] === 'string' &&
        comment['content'].startsWith(`GeoRoids diagnostic bundle ${report.id} `)
    );
    if (diagnosticComments.length !== expectedChunks.length) {
      throw new TodoistDeliveryError(
        'Diagnostic comment count does not match the saved bundle.',
        true
      );
    }
    const chunks: string[] = [];
    for (const content of expectedChunks) {
      const matches = comments.filter((comment) => comment['content'] === content);
      if (matches.length !== 1) {
        throw new TodoistDeliveryError(
          'Diagnostic comments are incomplete or duplicated; delivery needs review.',
          matches.length > 1
        );
      }
      chunks.push(content.slice(content.indexOf('\n') + 1));
    }
    const reconstructed = chunks.join('');
    if (
      digest(reconstructed) !== report.integrityHash ||
      Buffer.byteLength(reconstructed) !== Buffer.byteLength(report.bundle)
    ) {
      throw new TodoistDeliveryError('Diagnostic comment integrity verification failed.', true);
    }
    await this.openTask(taskId);
    await this.sync([{ ...ready, args: { ...ready.args, id: taskId } }]);
    const confirmed = await this.openTask(taskId);
    if (
      !record(confirmed) ||
      confirmed['content'] !== ready.args['content'] ||
      confirmed['description'] !== ready.args['description']
    ) {
      throw new TodoistDeliveryError('Todoist ready marker has not been confirmed.', false);
    }
    store.delivered(report.id);
  }
}
