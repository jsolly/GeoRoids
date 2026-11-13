import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { WorldStore } from './WorldStore';
import {
  serializeWorkerError,
  type WorldStoreWorkerReply,
  type WorldStoreWorkerRequest,
} from './worldStoreWorkerProtocol';
import { sampleWorldVolume } from './worldVolume';

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
const intent: unknown = workerData?.intent;
if (
  typeof path !== 'string' ||
  path.length === 0 ||
  (intent !== 'existing' && intent !== 'private')
) {
  reply({
    type: 'failed',
    id: undefined,
    error: serializeWorkerError(new Error('World store worker requires a database path')),
  });
  port.close();
} else {
  let store: WorldStore;
  try {
    store = new WorldStore(path, { intent });
    // The rows are indexed for duplicate detection; the game thread keeps its own copy.
    store.loadSectors();
    store.loadPilots();
    store.loadWorld();
  } catch (error) {
    reply({ type: 'failed', id: undefined, error: serializeWorkerError(error) });
    port.close();
    throw error;
  }
  // After a failed transaction the database no longer matches the game
  // thread's memory, so later batches built on that memory must not land
  // either; the process restarts from the last commit. Shutdown still closes.
  let failure: unknown;
  const reportVolume = (): void => reply({ type: 'volume', volume: sampleWorldVolume(path) });
  reportVolume();
  // The debug-report queue can fill the shared volume even while the world is paused.
  const volumeWatch = setInterval(reportVolume, 30_000);
  volumeWatch.unref();
  port.on('close', () => clearInterval(volumeWatch));
  port.on('message', (request: WorldStoreWorkerRequest) => {
    if (request.type === 'shutdown') {
      clearInterval(volumeWatch);
      try {
        store.close();
        reply({ type: 'done', id: request.id, durationMs: 0 });
      } catch (error) {
        reply({ type: 'failed', id: request.id, error: serializeWorkerError(error) });
      } finally {
        port.close();
      }
      return;
    }
    if (failure !== undefined) {
      reply({ type: 'failed', id: request.id, error: serializeWorkerError(failure) });
      return;
    }
    const started = performance.now();
    try {
      reportVolume();
      switch (request.type) {
        case 'persist':
          store.checkpoint(
            request.world,
            request.sectors,
            request.pilots,
            request.economy,
            request.cooperative,
            request.exploration
          );
          break;
        case 'reset':
          store.reset();
          break;
        default:
          throw new Error(`Unknown world store request ${JSON.stringify(request)}`);
      }
      reply({ type: 'done', id: request.id, durationMs: performance.now() - started });
    } catch (error) {
      failure = error;
      reply({ type: 'failed', id: request.id, error: serializeWorkerError(error) });
    }
  });
}
