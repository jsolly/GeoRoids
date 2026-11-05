import { vi } from 'vitest';

/** IndexedDB is external to the real recorder and runtime exercised by these tests. */
export function installPhoneRecordingStorage() {
  const rows = new Map<string, unknown>();
  let writeError = false;
  const close = vi.fn();
  const database = {
    close,
    transaction: () => {
      const transaction = {
        error: new Error('Storage write failed'),
        oncomplete: () => {},
        onerror: () => {},
        onabort: () => {},
        objectStore: () => ({
          clear: () => rows.clear(),
          put: (value: unknown, key: string) => rows.set(key, value),
          get: (key: string) => {
            const request = { result: rows.get(key), onsuccess: () => {} };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
        }),
      };
      queueMicrotask(() => (writeError ? transaction.onerror() : transaction.oncomplete()));
      return transaction;
    },
  };
  const open = vi.fn(() => {
    const request = { result: database, onsuccess: () => {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return {
    rows,
    close,
    open,
    failWrites: () => {
      writeError = true;
    },
  };
}
