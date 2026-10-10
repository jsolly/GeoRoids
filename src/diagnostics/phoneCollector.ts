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

export interface PhoneCollectorView {
  readonly phase: 'unavailable' | 'ready' | 'starting' | 'recording' | 'stopped' | 'recovering';
  readonly status: string;
  readonly device: string;
  readonly conditions: string;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canRecover: boolean;
  readonly canDownload: boolean;
}

export interface PhoneCollectorDownload {
  readonly blob: Blob;
  readonly filename: string;
}

/** Explicit activation leaves automated benchmark drains untouched. No UI is mounted here. */
export function createPhoneCollector(metrics: ClientPerformanceMetrics, changed: () => void) {
  const scope = new AbortController();
  const { signal } = scope;
  let disposed = false;
  let phase: PhoneCollectorView['phase'] = 'ready';
  let status = 'Performance: ready';
  let device = '';
  let conditions = '';
  let downloading = false;
  if (window.isSecureContext === false || !crypto.subtle || !crypto.randomUUID) {
    phase = 'unavailable';
    status = 'Collection requires HTTPS (or localhost) for checksummed downloads.';
  }
  const read = (): PhoneCollectorView => {
    const idle = !disposed && (phase === 'ready' || phase === 'stopped');
    return Object.freeze({
      phase,
      status,
      device,
      conditions,
      canStart: idle,
      canStop: !disposed && phase === 'recording',
      canRecover: idle,
      canDownload: idle && Boolean(active?.stopped) && !downloading,
    });
  };
  const publish = () => {
    if (!disposed) {
      changed();
    }
  };
  let database: IDBDatabase | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Session | undefined;
  let generation = 0;
  let startedAt = 0;
  let previousDrain = 0;
  let writing = Promise.resolve();
  let ownsDrain = false;
  const releaseDrain = () => {
    if (ownsDrain) {
      ownsDrain = false;
      metrics.releaseDrain(OWNER);
    }
  };
  const finish = (session: Session, reason: string | null) => {
    session.incompleteReason ??= reason;
    session.stopped = true;
    fitArtifact(session);
    if (active !== session) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
    releaseDrain();
    if (disposed) {
      return;
    }
    phase = 'stopped';
    status = session.incompleteReason
      ? `Incomplete: ${session.incompleteReason}`
      : 'Performance: stopped';
    publish();
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
    if (disposed) {
      return;
    }
    phase = active?.stopped ? 'stopped' : 'ready';
    status = `Incomplete: ${error instanceof Error ? error.message.slice(0, 256) : 'Storage unavailable'}`;
    publish();
  };
  const start = async (nextDevice: string, nextConditions: string): Promise<void> => {
    if (!read().canStart) {
      return;
    }
    const ticket = ++generation;
    phase = 'starting';
    device = nextDevice.slice(0, 256);
    conditions = nextConditions.slice(0, 512);
    downloading = false;
    publish();
    try {
      const store = await openStore();
      await writing;
      if (disposed || ticket !== generation) {
        store.close();
        return;
      }
      database?.close();
      database = store;
      const session: Session = {
        id: crypto.randomUUID(),
        metadata: {
          startedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
          language: navigator.language,
          timeOrigin: performance.timeOrigin,
          device,
          conditions,
        },
        incompleteReason: null,
        samples: [],
        escapedSampleBytes: 0,
        persistedSamples: 0,
        stopped: false,
      };
      metrics.claimDrain(OWNER);
      ownsDrain = true;
      active = session;
      startedAt = performance.now();
      previousDrain = startedAt;
      metrics.read(true, OWNER);
      phase = 'recording';
      status = 'Performance: recording';
      timer = setInterval(() => drain(session), 1000);
      save(session);
      publish();
    } catch (error) {
      if (ticket === generation) {
        showError(error);
      }
    }
  };
  const recover = async (): Promise<void> => {
    if (!read().canRecover) {
      return;
    }
    const ticket = ++generation;
    phase = 'recovering';
    downloading = false;
    publish();
    try {
      const store = await openStore();
      let session: Session | undefined;
      try {
        await writing;
        if (disposed || ticket !== generation) {
          return;
        }
        session = await recoverSession(store);
      } finally {
        store.close();
      }
      if (disposed || ticket !== generation) {
        return;
      }
      if (!session) {
        phase = active?.stopped ? 'stopped' : 'ready';
        status = 'No saved performance session.';
        publish();
        return;
      }
      active = session;
      device = session.metadata.device.slice(0, 256);
      conditions = session.metadata.conditions.slice(0, 512);
      finish(session, null);
      if (!session.incompleteReason) {
        status = 'Performance: recovered';
        publish();
      }
    } catch (error) {
      if (ticket === generation) {
        showError(error);
      }
    }
  };
  const stop = () => {
    if (!read().canStop || !active) {
      return;
    }
    drain(active);
    finish(active, null);
    save(active);
  };
  document.addEventListener(
    'visibilitychange',
    () => {
      if (active && !active.stopped && document.hidden) {
        drain(active);
        save(active);
      }
    },
    { signal }
  );
  window.addEventListener(
    'pagehide',
    () => {
      if (active && !active.stopped) {
        drain(active);
        finish(active, 'Page closed before explicit Stop');
        save(active);
      }
    },
    { signal }
  );
  const download = async (): Promise<PhoneCollectorDownload | null> => {
    const session = active;
    if (!read().canDownload || !session) {
      return null;
    }
    const ticket = generation;
    downloading = true;
    publish();
    try {
      await writing;
      if (disposed || ticket !== generation) {
        return null;
      }
      const content = `${prefix(session)}${session.samples.join(',')}]}`;
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content));
      if (disposed || ticket !== generation) {
        return null;
      }
      const checksum = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      return {
        blob: new Blob([JSON.stringify({ checksum, checksumAlgorithm: 'SHA-256', content })], {
          type: 'application/json',
        }),
        filename: `georoids-performance-${session.id}.json`,
      };
    } catch (error) {
      if (!disposed && ticket === generation) {
        status = `Download failed: ${error instanceof Error ? error.message.slice(0, 256) : 'unknown error'}`;
      }
      return null;
    } finally {
      if (!disposed && ticket === generation) {
        downloading = false;
        publish();
      }
    }
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    generation++;
    scope.abort();
    if (active && !active.stopped) {
      drain(active);
      finish(active, 'Game shell unmounted before explicit Stop');
      save(active);
    }
    clearInterval(timer);
    releaseDrain();
    const store = database;
    database = undefined;
    void writing.finally(() => store?.close());
  };
  return { read, start, stop, recover, download, dispose };
}
