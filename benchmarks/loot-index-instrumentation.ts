import type { LootManager } from '../server/core/LootManager';

function readObject(owner: object, key: string): object {
  const value: unknown = Reflect.get(owner, key);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Loot instrumentation expected object ${key}`);
  }
  return value;
}

function readMap(owner: object, key: string): Map<unknown, unknown> {
  const value = readObject(owner, key);
  if (!(value instanceof Map)) {
    throw new Error(`Loot instrumentation expected Map ${key}`);
  }
  return value;
}

function readSet(owner: object, key: string): Set<unknown> {
  const value = readObject(owner, key);
  if (!(value instanceof Set)) {
    throw new Error(`Loot instrumentation expected Set ${key}`);
  }
  return value;
}

function heapSize(queue: object): number {
  const heap = readObject(queue, 'heap');
  if (!Array.isArray(heap)) {
    throw new Error('Loot instrumentation expected deadline heap array');
  }
  return heap.length;
}

/** Observe real owner operations only when requested by a benchmark or test. */
export function instrumentLootIndex(manager: LootManager) {
  const counts = {
    cellVisits: 0,
    bucketEntries: 0,
    motionRows: 0,
    publicRows: 0,
    expiryPops: 0,
    deadlineUpserts: 0,
    deadlineRemovals: 0,
  };
  const restorations: (() => void)[] = [];
  const observedBuckets = new WeakSet<Set<unknown>>();
  const cells = readMap(manager, 'cells');
  const frameExpiry = readObject(manager, 'frameExpiry');
  const wallExpiry = readObject(manager, 'wallExpiry');
  let boundsDepth = 0;
  let expireDepth = 0;
  let popDepth = 0;

  function replace(target: object, key: PropertyKey, replacement: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!Reflect.set(target, key, replacement)) {
      throw new Error(`Loot instrumentation could not wrap ${String(key)}`);
    }
    restorations.push(() => {
      if (descriptor) {
        Object.defineProperty(target, key, descriptor);
      } else if (!Reflect.deleteProperty(target, key)) {
        throw new Error(`Loot instrumentation could not restore ${String(key)}`);
      }
    });
  }

  function wrap(target: object, key: string, observe: (invoke: () => unknown) => unknown): void {
    const original: unknown = Reflect.get(target, key);
    if (typeof original !== 'function') {
      throw new Error(`Loot instrumentation expected method ${key}`);
    }
    replace(target, key, function (this: unknown, ...args: unknown[]) {
      return observe(() => Reflect.apply(original, this, args));
    });
  }

  wrap(manager, 'inBounds', (invoke) => {
    boundsDepth++;
    try {
      return invoke();
    } finally {
      boundsDepth--;
    }
  });
  wrap(cells, 'get', (invoke) => {
    const bucket = invoke();
    if (boundsDepth > 0) {
      counts.cellVisits++;
      if (bucket !== undefined && !(bucket instanceof Set)) {
        throw new Error('Loot instrumentation expected cell bucket Set');
      }
      if (bucket instanceof Set && !observedBuckets.has(bucket)) {
        const rows: Set<unknown> = bucket;
        const iterate = rows[Symbol.iterator].bind(rows);
        replace(rows, Symbol.iterator, function* () {
          for (const row of iterate()) {
            if (boundsDepth > 0) {
              counts.bucketEntries++;
            }
            yield row;
          }
        });
        observedBuckets.add(rows);
      }
    }
    return bucket;
  });
  wrap(manager, 'expire', (invoke) => {
    expireDepth++;
    try {
      return invoke();
    } finally {
      expireDepth--;
    }
  });
  wrap(manager, 'inInsertionOrder', (invoke) => {
    const rows = invoke();
    if (expireDepth > 0) {
      if (!Array.isArray(rows)) {
        throw new Error('Loot instrumentation expected ordered motion array');
      }
      counts.motionRows += rows.length;
    }
    return rows;
  });
  wrap(manager, 'toPublic', (invoke) => {
    counts.publicRows++;
    return invoke();
  });
  function observeRemoval(invoke: () => unknown): unknown {
    const removed = invoke();
    if (removed !== undefined && popDepth === 0) {
      counts.deadlineRemovals++;
    }
    return removed;
  }
  function observeDue(invoke: () => unknown): unknown {
    popDepth++;
    try {
      const due = invoke();
      if (due !== undefined) {
        counts.expiryPops++;
      }
      return due;
    } finally {
      popDepth--;
    }
  }
  for (const queue of [frameExpiry, wallExpiry]) {
    wrap(queue, 'upsert', (invoke) => {
      counts.deadlineUpserts++;
      return invoke();
    });
    wrap(queue, 'remove', observeRemoval);
    wrap(queue, 'popDue', observeDue);
  }

  return {
    snapshot() {
      return {
        ...counts,
        authoritativeRows: readMap(manager, 'loot').size,
        occupiedCells: cells.size,
        movingRows: readSet(manager, 'moving').size,
        ejectingRows: readSet(manager, 'ejecting').size,
        disposableRows: readSet(manager, 'disposable').size,
        pointRows: readSet(manager, 'points').size,
        frameDeadlines: heapSize(frameExpiry),
        wallDeadlines: heapSize(wallExpiry),
      };
    },
    dispose() {
      for (const restore of restorations.splice(0).reverse()) {
        restore();
      }
    },
  };
}
