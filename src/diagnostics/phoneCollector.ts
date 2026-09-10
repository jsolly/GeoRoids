import type { ClientPerformanceMetrics } from './performanceMetrics';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DURATION_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();
const OWNER = 'phone collector';
type Metadata = {
  startedAt: string;
  userAgent: string;
  language: string;
  timeOrigin: number;
  device: string;
  conditions: string;
};
type Session = {
  id: string;
  metadata: Metadata;
  incompleteReason: string | null;
  samples: string[];
  escapedSampleBytes: number;
  persistedSamples: number;
  stopped: boolean;
};

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('georoids-performance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage unavailable'));
    request.onblocked = () => reject(new Error('Performance storage is blocked'));
  });
}

function readStored(database: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database.transaction('sessions').objectStore('sessions').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Storage read failed'));
  });
}

function saveStored(
  database: IDBDatabase,
  entries: [string, unknown][],
  replace = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('sessions', 'readwrite');
    if (replace) {
      transaction.objectStore('sessions').clear();
    }
    for (const [key, value] of entries) {
      transaction.objectStore('sessions').put(value, key);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Storage write failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Storage write aborted'));
  });
}

function escapedBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).byteLength - 2;
}

function prefix(session: Session): string {
  return `${JSON.stringify({ schemaVersion: 2, sessionId: session.id, metadata: session.metadata, incompleteReason: session.incompleteReason }).slice(0, -1)},"samples":[`;
}

/** Counts the final UTF-8 JSON envelope, including escaped raw JSON and the fixed-size digest. */
function artifactBytes(session: Session): number {
  const envelope = JSON.stringify({
    checksum: '0'.repeat(64),
    checksumAlgorithm: 'SHA-256',
    content: '',
  });
  return (
    encoder.encode(envelope).byteLength +
    escapedBytes(prefix(session)) +
    session.escapedSampleBytes +
    Math.max(0, session.samples.length - 1) +
    escapedBytes(']}')
  );
}

function fitArtifact(session: Session): void {
  while (artifactBytes(session) > MAX_BYTES && session.samples.length > 0) {
    const removed = session.samples.pop();
    if (removed !== undefined) {
      session.escapedSampleBytes -= escapedBytes(removed);
    }
    session.incompleteReason = '32 MiB artifact limit reached; samples omitted';
  }
}

function isMetadata(value: unknown): value is Metadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'startedAt' in value &&
    typeof value.startedAt === 'string' &&
    'userAgent' in value &&
    typeof value.userAgent === 'string' &&
    'language' in value &&
    typeof value.language === 'string' &&
    'timeOrigin' in value &&
    typeof value.timeOrigin === 'number' &&
    'device' in value &&
    typeof value.device === 'string' &&
    'conditions' in value &&
    typeof value.conditions === 'string'
  );
}

async function recoverSession(database: IDBDatabase): Promise<Session | undefined> {
  const id = await readStored(database, 'latest');
  if (typeof id !== 'string') {
    return undefined;
  }
  const header = await readStored(database, id);
  if (
    typeof header !== 'object' ||
    header === null ||
    !('metadata' in header) ||
    !isMetadata(header.metadata) ||
    !('sampleCount' in header) ||
    typeof header.sampleCount !== 'number' ||
    !Number.isSafeInteger(header.sampleCount) ||
    header.sampleCount < 0 ||
    header.sampleCount > MAX_BYTES / 2 ||
    !('stopped' in header) ||
    typeof header.stopped !== 'boolean' ||
    !('incompleteReason' in header) ||
    (header.incompleteReason !== null && typeof header.incompleteReason !== 'string')
  ) {
    throw new Error('Saved performance session is invalid');
  }
  const session: Session = {
    id,
    metadata: header.metadata,
    incompleteReason: header.incompleteReason,
    samples: [],
    escapedSampleBytes: 0,
    persistedSamples: 0,
    stopped: true,
  };
  for (let index = 0; index < header.sampleCount; index++) {
    const sample = await readStored(database, `${id}:${index}`);
    if (typeof sample !== 'string') {
      session.incompleteReason = 'Saved collection has missing samples';
      break;
    }
    try {
      const value: unknown = JSON.parse(sample);
      if (
        !value ||
        typeof value !== 'object' ||
        !('metrics' in value) ||
        !('counters' in value) ||
        !('durationMs' in value) ||
        typeof value.durationMs !== 'number' ||
        !Number.isFinite(value.durationMs)
      ) {
        throw new Error('Invalid saved sample');
      }
    } catch {
      session.incompleteReason = 'Saved collection has a corrupt sample';
      break;
    }
    session.samples.push(sample);
    session.escapedSampleBytes += escapedBytes(sample);
    if (artifactBytes(session) > MAX_BYTES) {
      fitArtifact(session);
      break;
    }
  }
  if (!header.stopped) {
    session.incompleteReason ??= 'Recording interrupted before Stop; unsaved interval unavailable';
  }
  return session;
}

/** Explicit user activation leaves automated benchmark drains untouched. */
export function installPhoneCollector(metrics: ClientPerformanceMetrics): void {
  const panel = document.createElement('aside');
  panel.setAttribute('aria-label', 'Performance collection');
  panel.style.cssText =
    'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:10000;background:#111;color:white;padding:8px;font:14px sans-serif;max-width:calc(100vw - 16px)';
  const status = document.createElement('span');
  status.textContent = 'Performance: ready ';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  status.tabIndex = -1;
  const retainCollectorFocus = () => {
    if (panel.contains(document.activeElement)) {
      status.focus();
    }
  };
  const device = document.createElement('input');
  device.setAttribute('aria-label', 'Device model and OS');
  device.placeholder = 'Device model and OS';
  device.maxLength = 256;
  const conditions = document.createElement('input');
  conditions.setAttribute('aria-label', 'Test conditions');
  conditions.placeholder = 'Power, brightness, network, cooldown';
  conditions.maxLength = 512;
  const start = document.createElement('button');
  start.textContent = 'Start';
  const stop = document.createElement('button');
  stop.textContent = 'Stop';
  stop.disabled = true;
  const download = document.createElement('button');
  download.textContent = 'Download';
  download.disabled = true;
  const recover = document.createElement('button');
  recover.textContent = 'Recover last session';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const note = document.createElement('p');
  note.textContent =
    'Model and conditions are required for comparisons. Starting replaces the saved session; download it first.';
  summary.textContent = 'Device and conditions';
  details.append(summary, note, device, conditions);
  panel.append(status, start, stop, download, recover, details);
  document.body.append(panel);
  if (window.isSecureContext === false || !crypto.subtle || !crypto.randomUUID) {
    status.textContent = 'Collection requires HTTPS (or localhost) for checksummed downloads. ';
    start.disabled = true;
    recover.disabled = true;
    return;
  }

  let database: IDBDatabase | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Session | undefined;
  let generation = 0;
  let startedAt = 0;
  let previousDrain = 0;
  let writing = Promise.resolve();
  const finish = (session: Session, reason: string | null) => {
    session.incompleteReason ??= reason;
    session.stopped = true;
    fitArtifact(session);
    if (active !== session) {
      return;
    }
    retainCollectorFocus();
    if (timer !== undefined) {
      clearInterval(timer);
    }
    timer = undefined;
    metrics.releaseDrain(OWNER);
    start.disabled = false;
    recover.disabled = false;
    stop.disabled = true;
    download.disabled = false;
    device.disabled = false;
    conditions.disabled = false;
    details.hidden = false;
    start.hidden = false;
    download.hidden = false;
    recover.hidden = false;
    status.textContent = session.incompleteReason
      ? `Incomplete: ${session.incompleteReason} `
      : 'Performance: stopped ';
  };
  const save = (session: Session) => {
    const store = database;
    if (!store) {
      return;
    }
    const replace = session.persistedSamples === 0 && session.samples.length === 0;
    const entries: [string, unknown][] = [];
    for (let index = session.persistedSamples; index < session.samples.length; index++) {
      entries.push([`${session.id}:${index}`, session.samples[index]]);
    }
    session.persistedSamples = session.samples.length;
    entries.push(
      [
        session.id,
        {
          metadata: session.metadata,
          incompleteReason: session.incompleteReason,
          sampleCount: session.samples.length,
          stopped: session.stopped,
        },
      ],
      ['latest', session.id]
    );
    writing = writing
      .then(() => saveStored(store, entries, replace))
      .catch((error: unknown) =>
        finish(session, error instanceof Error ? error.message.slice(0, 256) : 'Storage failure')
      );
  };
  const drain = (session: Session) => {
    if (active !== session || session.stopped) {
      return;
    }
    const now = performance.now();
    if (now - previousDrain > 1500) {
      metrics.record('collectionGapMs', now - previousDrain - 1000);
      if (now - startedAt < MAX_DURATION_MS) {
        session.incompleteReason ??= 'Collection delayed; inspect phase and gap coverage';
      }
    }
    previousDrain = now;
    const sample = metrics.read(true, OWNER);
    const serialized = JSON.stringify(sample);
    session.samples.push(serialized);
    session.escapedSampleBytes += escapedBytes(serialized);
    if (Object.values(sample.metrics).some((metric) => metric.omittedSamples > 0)) {
      session.incompleteReason ??= 'Recorder capacity exceeded; raw samples omitted';
    }
    if (artifactBytes(session) > MAX_BYTES) {
      finish(session, '32 MiB artifact limit reached; samples omitted');
      save(session);
    } else if (now - startedAt >= MAX_DURATION_MS) {
      finish(session, '30 minute collection limit reached');
      save(session);
    } else if (session.samples.length % 5 === 0) {
      save(session);
    }
  };
  const showError = (error: unknown) => {
    status.textContent = `Incomplete: ${error instanceof Error ? error.message : 'Storage unavailable'} `;
    start.disabled = false;
    recover.disabled = false;
    download.disabled = !active?.stopped;
  };
  start.addEventListener('click', () => {
    retainCollectorFocus();
    const ticket = ++generation;
    start.disabled = true;
    recover.disabled = true;
    download.disabled = true;
    void openStore()
      .then(async (store) => {
        await writing;
        if (ticket !== generation) {
          store.close();
          return;
        }
        database?.close();
        database = store;
        metrics.claimDrain(OWNER);
        const session: Session = {
          id: crypto.randomUUID(),
          metadata: {
            startedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            language: navigator.language,
            timeOrigin: performance.timeOrigin,
            device: device.value,
            conditions: conditions.value,
          },
          incompleteReason: null,
          samples: [],
          escapedSampleBytes: 0,
          persistedSamples: 0,
          stopped: false,
        };
        active = session;
        startedAt = performance.now();
        previousDrain = startedAt;
        metrics.read(true, OWNER);
        stop.disabled = false;
        device.disabled = true;
        conditions.disabled = true;
        details.hidden = true;
        start.hidden = true;
        download.hidden = true;
        recover.hidden = true;
        status.textContent = 'Performance: recording ';
        timer = setInterval(() => drain(session), 1000);
        save(session);
      })
      .catch((error: unknown) => {
        if (ticket === generation) {
          showError(error);
        }
      });
  });
  recover.addEventListener('click', () => {
    retainCollectorFocus();
    const ticket = ++generation;
    recover.disabled = true;
    start.disabled = true;
    download.disabled = true;
    void openStore()
      .then(async (store) => {
        await writing;
        let session: Session | undefined;
        try {
          session = await recoverSession(store);
        } finally {
          store.close();
        }
        if (ticket !== generation) {
          return;
        }
        if (!session) {
          status.textContent = 'No saved performance session. ';
          start.disabled = false;
          recover.disabled = false;
          return;
        }
        active = session;
        device.value = session.metadata.device;
        conditions.value = session.metadata.conditions;
        finish(session, null);
        if (!session.incompleteReason) {
          status.textContent = 'Performance: recovered ';
        }
      })
      .catch((error: unknown) => {
        if (ticket === generation) {
          showError(error);
        }
      });
  });
  stop.addEventListener('click', () => {
    if (active) {
      drain(active);
      finish(active, null);
      save(active);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (active && !active.stopped && document.hidden) {
      drain(active);
      save(active);
    }
  });
  window.addEventListener('pagehide', () => {
    if (active && !active.stopped) {
      drain(active);
      finish(active, 'Page closed before explicit Stop');
      save(active);
    }
  });
  download.addEventListener('click', () => {
    const session = active;
    if (!session?.stopped) {
      return;
    }
    const id = session.id;
    const pendingWrites = writing;
    void (async () => {
      await pendingWrites;
      const content = `${prefix(session)}${session.samples.join(',')}]}`;
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
      const checksum = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ checksum, checksumAlgorithm: 'SHA-256', content })], {
          type: 'application/json',
        })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `georoids-performance-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })().catch((error: unknown) => {
      if (active === session) {
        status.textContent = `Download failed: ${error instanceof Error ? error.message : 'unknown error'} `;
      }
    });
  });
}
