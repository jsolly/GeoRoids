import type { AsteroidData } from '../../shared-types';
import type { PersistentPilot, SavedWorld } from './WorldStore';

/** Messages the game thread sends to the world-store worker. */
export type WorldStoreWorkerRequest =
  | {
      type: 'persist';
      id: number;
      world: SavedWorld;
      /** Map entries; a Map survives structured clone but an array is cheaper to inspect. */
      sectors: Array<[string, AsteroidData[]]>;
      pilots: PersistentPilot[];
    }
  | { type: 'reset'; id: number }
  | { type: 'shutdown'; id: number };

/** Messages the worker sends back; every request is answered exactly once. */
export type WorldStoreWorkerReply =
  | { type: 'ready' }
  | { type: 'committed'; id: number; durationMs: number }
  | { type: 'reset'; id: number }
  | { type: 'closed'; id: number }
  | { type: 'failed'; id: number | undefined; error: SerializedWorkerError };

/** Errors cross the thread boundary as plain data and are rebuilt on arrival. */
interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: typeof error === 'string' ? error : JSON.stringify(error) };
}

export function deserializeWorkerError(error: SerializedWorkerError): Error {
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  if (error.stack) {
    rebuilt.stack = error.stack;
  }
  return rebuilt;
}
