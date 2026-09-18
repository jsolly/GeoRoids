import type { AsteroidData } from '../../shared-types';
import type { PersistentPilot, SavedWorld } from './WorldStore';

/** Messages the game thread sends to the world-store worker. */
export type WorldStoreWorkerRequest =
  | {
      type: 'persist';
      id: number;
      world: SavedWorld | undefined;
      /** Structured clone carries the Map as-is; the worker validates its contents. */
      sectors: ReadonlyMap<string, AsteroidData[]>;
      pilots: PersistentPilot[];
    }
  | { type: 'reset'; id: number }
  | { type: 'shutdown'; id: number };

/**
 * Messages the worker sends back. Every request is answered exactly once, so
 * the game thread can treat the set of unanswered ids as "not yet durable".
 * A startup failure has no request to answer and carries no id.
 */
export type WorldStoreWorkerReply =
  | { type: 'done'; id: number; durationMs: number }
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
