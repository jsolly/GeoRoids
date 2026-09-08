/**
 * Best-effort web storage. When cookies/storage are blocked, localStorage
 * get/set can throw (Firefox, Safari private mode, "block all cookies").
 * Fall back to in-memory values for this tab only so callers never crash.
 */

const memory = new Map<string, string>();
let persistAvailable: boolean | undefined;
const reportedFailures = new Set<'access' | 'probe' | 'read' | 'write' | 'remove'>();

function normalizeFailureCause(error: unknown): string {
  try {
    let cause = 'unknown-error';
    if (error instanceof Error) {
      cause = error.name || 'Error';
    } else if (typeof error === 'object' && error !== null) {
      const candidate = error as { code?: unknown; name?: unknown };
      if (typeof candidate['name'] === 'string' && candidate['name']) {
        cause = candidate['name'];
      } else if (typeof candidate['code'] === 'string' || typeof candidate['code'] === 'number') {
        cause = `code-${String(candidate['code'])}`;
      }
    }
    return cause.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'unknown-error';
  } catch {
    return 'unknown-error';
  }
}

function reportStorageFallback(
  operation: 'access' | 'probe' | 'read' | 'write' | 'remove',
  error?: unknown
): void {
  // Keep the signal bounded and never include the caller's key or value. Keys
  // can contain account/session identifiers, while one warning per operation
  // is enough to explain why this tab is using memory-only storage.
  if (reportedFailures.has(operation)) {
    return;
  }
  reportedFailures.add(operation);
  const cause = error === undefined ? 'unavailable' : normalizeFailureCause(error);
  try {
    console.warn(
      `[STORAGE] localStorage unavailable during ${operation} (${cause}); using in-memory fallback`
    );
  } catch {
    // Console implementations are outside the storage contract.
  }
}

function getLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ?? null;
  } catch (error) {
    reportStorageFallback('access', error);
    return null;
  }
}

function canPersist(): boolean {
  if (persistAvailable === false) {
    return false;
  }
  const storage = getLocalStorage();
  if (!storage) {
    persistAvailable = false;
    reportStorageFallback('probe');
    return false;
  }
  if (persistAvailable === true) {
    return true;
  }
  try {
    const probeKey = '__georoids_storage_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    persistAvailable = true;
    return true;
  } catch (error) {
    persistAvailable = false;
    reportStorageFallback('probe', error);
    return false;
  }
}

export function getStoredItem(key: string): string | null {
  if (canPersist()) {
    try {
      return getLocalStorage()?.getItem(key) ?? null;
    } catch (error) {
      persistAvailable = false;
      reportStorageFallback('read', error);
    }
  }
  return memory.get(key) ?? null;
}

export function setStoredItem(key: string, value: string): void {
  if (canPersist()) {
    try {
      getLocalStorage()?.setItem(key, value);
      return;
    } catch (error) {
      persistAvailable = false;
      reportStorageFallback('write', error);
    }
  }
  memory.set(key, value);
}

export function removeStoredItem(key: string): void {
  if (canPersist()) {
    try {
      getLocalStorage()?.removeItem(key);
      return;
    } catch (error) {
      persistAvailable = false;
      reportStorageFallback('remove', error);
    }
  }
  memory.delete(key);
}

/** Reset probe cache and in-memory fallback (unit tests). */
export function resetSafeStorage(): void {
  memory.clear();
  persistAvailable = undefined;
  reportedFailures.clear();
}
