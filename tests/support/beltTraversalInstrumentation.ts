import type { GameEngine } from '../../server/core/GameEngine';
import type { AsteroidData } from '../../shared-types';

function readObject(owner: object, key: string): object {
  const value: unknown = Reflect.get(owner, key);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Belt instrumentation expected object ${key}`);
  }
  return value;
}

function readMap(owner: object, key: string): Map<string, AsteroidData> {
  const value = readObject(owner, key);
  if (!(value instanceof Map)) {
    throw new Error(`Belt instrumentation expected Map ${key}`);
  }
  return value as Map<string, AsteroidData>;
}

/**
 * Count the belt walks a frame actually performs. The 60 Hz loop owes the
 * asteroid belt one pass for physics; anything that walks it again shows up
 * here as another pass rather than as a timing wobble.
 *
 * Observe real owner operations only when requested by a test.
 */
export function instrumentBeltTraversals(engine: GameEngine) {
  const counts = { beltPasses: 0, rowsVisited: 0, beltCopies: 0 };
  const restorations: (() => void)[] = [];
  const manager = readObject(engine, 'asteroidManager');
  const rows = readMap(manager, 'asteroids');
  const index = readObject(manager, 'index');

  function replace(target: object, key: PropertyKey, replacement: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!Reflect.set(target, key, replacement)) {
      throw new Error(`Belt instrumentation could not wrap ${String(key)}`);
    }
    restorations.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else if (!Reflect.deleteProperty(target, key)) {
        throw new Error(`Belt instrumentation could not restore ${String(key)}`);
      }
    });
  }

  /** Every way to walk the whole belt funnels through one of these. */
  function countWalk(target: object, key: PropertyKey): void {
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== 'function') {
      throw new Error(`Belt instrumentation expected method ${String(key)}`);
    }
    replace(target, key, function* (this: unknown, ...args: unknown[]) {
      counts.beltPasses++;
      const walked: unknown = Reflect.apply(original, this, args);
      if (typeof walked !== 'object' || walked === null || !(Symbol.iterator in walked)) {
        throw new Error(`Belt instrumentation expected an iterable from ${String(key)}`);
      }
      for (const row of walked as Iterable<unknown>) {
        counts.rowsVisited++;
        yield row;
      }
    });
  }

  countWalk(rows, 'values');
  countWalk(rows, Symbol.iterator);
  countWalk(rows, 'entries');
  countWalk(index, 'values');

  const copy: unknown = Reflect.get(manager, 'getAllAsteroids');
  if (typeof copy !== 'function') {
    throw new Error('Belt instrumentation expected getAllAsteroids');
  }
  replace(manager, 'getAllAsteroids', function (this: unknown, ...args: unknown[]) {
    counts.beltCopies++;
    return Reflect.apply(copy, this, args);
  });

  return {
    snapshot() {
      return { ...counts, beltRows: rows.size };
    },
    reset() {
      counts.beltPasses = 0;
      counts.rowsVisited = 0;
      counts.beltCopies = 0;
    },
    dispose() {
      for (const restore of restorations.splice(0).reverse()) {
        restore();
      }
    },
  };
}
