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

function readSet(owner: object, key: string): Set<string> {
  const value = readObject(owner, key);
  if (!(value instanceof Set)) {
    throw new Error(`Belt instrumentation expected Set ${key}`);
  }
  return value as Set<string>;
}

/**
 * Count the belt walks a frame actually performs. The 60 Hz loop owes the
 * asteroid belt one pass for physics; anything that walks it again shows up
 * here as another pass rather than as a timing wobble.
 *
 * Observe real owner operations only when requested by a test.
 */
export function instrumentBeltTraversals(engine: GameEngine) {
  const counts = { beltPasses: 0, rowsVisited: 0, beltCopies: 0, trackedRows: 0 };
  const restorations: (() => void)[] = [];
  const manager = readObject(engine, 'asteroidManager');
  const rows = readMap(manager, 'asteroids');

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

  /**
   * Count a belt walk. Detection is route-specific: this covers the iterating
   * members of the backing map, which is every way production currently walks
   * the belt. A walk written another way — a spatial query with world-sized
   * bounds, say — would need adding here, so keep the list and the budget
   * together.
   */
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
  countWalk(rows, 'keys');

  // `forEach` walks without an iterator, so count its callback instead.
  const sweep: unknown = Reflect.get(rows, 'forEach');
  if (typeof sweep !== 'function') {
    throw new Error('Belt instrumentation expected forEach');
  }
  replace(rows, 'forEach', function (this: unknown, ...args: unknown[]) {
    const visit = args[0];
    if (typeof visit !== 'function') {
      return Reflect.apply(sweep, this, args);
    }
    counts.beltPasses++;
    return Reflect.apply(sweep, this, [
      function (this: unknown, ...row: unknown[]) {
        counts.rowsVisited++;
        return Reflect.apply(visit, this, row);
      },
      ...args.slice(1),
    ]);
  });

  /**
   * Work reached through a tracked set rather than a belt walk: these are the
   * routes that replaced the removed walks. Counts the ids each call
   * **considers**, not the rows it yields. A set that fills with ids whose
   * rocks are gone, or whose boost has cleared, prunes them before yielding —
   * so counting yields would miss exactly the growth the sets are supposed to
   * be bounded against, which is the one thing that makes them cheaper than
   * the walk.
   */
  for (const [key, field] of Object.entries({
    boostedAsteroids: 'boosted',
    crawlerHostAsteroids: 'crawlerHosts',
  })) {
    const reach: unknown = Reflect.get(manager, key);
    if (typeof reach !== 'function') {
      throw new Error(`Belt instrumentation expected ${key}`);
    }
    replace(manager, key, function* (this: unknown, ...args: unknown[]) {
      counts.trackedRows += readSet(manager, field).size;
      const reached: unknown = Reflect.apply(reach, this, args);
      if (typeof reached !== 'object' || reached === null || !(Symbol.iterator in reached)) {
        throw new Error(`Belt instrumentation expected an iterable from ${key}`);
      }
      yield* reached as Iterable<unknown>;
    });
  }

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
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
        counts[key] = 0;
      }
    },
    dispose() {
      for (const restore of restorations.splice(0).reverse()) {
        restore();
      }
    },
  };
}
