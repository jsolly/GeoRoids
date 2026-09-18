import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { WorldStore } from './WorldStore';
import {
  serializeWorkerError,
  type WorldStoreWorkerReply,
  type WorldStoreWorkerRequest,
} from './worldStoreWorkerProtocol';

/**
 * Owns the only writable connection to the world database. Requests are
 * applied strictly in arrival order, so a reset or shutdown queued behind a
 * batch always sees that batch committed first.
 */
if (isMainThread || !parentPort) {
  throw new Error('worldStoreWorker must run inside a worker thread');
}
const port = parentPort;
const reply = (message: WorldStoreWorkerReply): void => {
  port.postMessage(message);
};

const path: unknown = workerData?.path;
if (typeof path !== 'string' || path.length === 0) {
  reply({
    type: 'failed',
    id: undefined,
    error: serializeWorkerError(new Error('World store worker requires a database path')),
  });
  port.close();
} else {
  let store: WorldStore;
  try {
    store = new WorldStore(path);
    // The rows are indexed for duplicate detection; the game thread keeps its own copy.
    store.loadSectors();
    store.loadPilots();
    store.loadWorld();
  } catch (error) {
    reply({ type: 'failed', id: undefined, error: serializeWorkerError(error) });
    port.close();
    throw error;
  }
  reply({ type: 'ready' });
  port.on('message', (request: WorldStoreWorkerRequest) => {
    try {
      switch (request.type) {
        case 'persist': {
          const started = performance.now();
          store.checkpoint(request.world, new Map(request.sectors), request.pilots);
          reply({ type: 'committed', id: request.id, durationMs: performance.now() - started });
          return;
        }
        case 'reset':
          store.reset();
          reply({ type: 'reset', id: request.id });
          return;
        case 'shutdown':
          store.close();
          reply({ type: 'closed', id: request.id });
          port.close();
          return;
        default:
          throw new Error(`Unknown world store request ${JSON.stringify(request)}`);
      }
    } catch (error) {
      reply({ type: 'failed', id: request.id, error: serializeWorkerError(error) });
    }
  });
}
