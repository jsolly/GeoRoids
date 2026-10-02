// @vitest-environment node
import crypto, { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { ownBenchmarkIdentity } from '../../../benchmarks/benchmark-identity';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function ids(seed: number, consumeMathRandom: boolean): string[] {
  const owner = ownBenchmarkIdentity(seed);
  try {
    expect(owner.source).toBe('benchmark-owned-seeded-node-crypto-randomUUID-v1');
    expect(randomUUID).toBe(crypto.randomUUID);
    return Array.from({ length: 128 }, (_, index) => {
      if (consumeMathRandom) {
        for (let draw = 0; draw <= index; draw++) {
          Math.random();
        }
      }
      // Alternate the actual default and named Node builtin import boundaries.
      return index % 2 ? crypto.randomUUID({ disableEntropyCache: true }) : randomUUID();
    });
  } finally {
    owner.release();
  }
}

test('benchmark pilots keep unique reproducible UUIDs while gameplay RNG consumption changes', () => {
  const originalDefault = crypto.randomUUID;
  const originalNamed = randomUUID;
  const first = ids(42, false);
  const repeated = ids(42, true);
  const different = ids(43, false);
  expect(repeated).toEqual(first);
  expect(new Set(first).size).toBe(first.length);
  expect(new Set([...first, ...different]).size).toBe(first.length + different.length);
  const extremes = [Number.MIN_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER].flatMap((seed) =>
    ids(seed, false)
  );
  expect(new Set([...first, ...different, ...extremes]).size).toBe(
    first.length + different.length + extremes.length
  );
  for (const id of [...first, ...different, ...extremes]) {
    expect(id).toMatch(UUID_V4);
  }
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
});

test('failed benchmark work restores the exact production UUID bindings before another owner starts', () => {
  const originalDefault = crypto.randomUUID;
  const originalNamed = randomUUID;
  const failure = new Error('Controlled benchmark failure');
  expect(() => {
    const owner = ownBenchmarkIdentity(42);
    try {
      expect(randomUUID).not.toBe(originalNamed);
      randomUUID();
      throw failure;
    } finally {
      owner.release();
      owner.release();
    }
  }).toThrow(failure);
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
  expect(ids(42, false)).toEqual(ids(42, false));
  expect(() => ownBenchmarkIdentity(Number.NaN)).toThrow('safe integer');
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
});

test('overlapping benchmark sessions cannot replace each other’s UUID ownership', async () => {
  const originalDefault = crypto.randomUUID;
  const originalNamed = randomUUID;
  const owner = ownBenchmarkIdentity(42);
  try {
    const controlled = randomUUID;
    expect(() => ownBenchmarkIdentity(43)).toThrow('already owned');
    await expect(Promise.resolve().then(() => ownBenchmarkIdentity(44))).rejects.toThrow(
      'already owned'
    );
    expect(randomUUID).toBe(controlled);
    expect(crypto.randomUUID).toBe(controlled);
    expect(new Set([randomUUID(), crypto.randomUUID()]).size).toBe(2);
  } finally {
    owner.release();
  }
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
});

test('an unsynchronized crypto spy cannot make a benchmark overwrite the original named binding', () => {
  const originalDefault = crypto.randomUUID;
  const originalNamed = randomUUID;
  const defaultSpy = vi.spyOn(crypto, 'randomUUID');
  try {
    expect(crypto.randomUUID).not.toBe(randomUUID);
    expect(() => ownBenchmarkIdentity(42)).toThrow('bindings must match before ownership');
    expect(crypto.randomUUID).toBe(defaultSpy);
    expect(randomUUID).toBe(originalNamed);
    expect(defaultSpy).not.toHaveBeenCalled();
  } finally {
    defaultSpy.mockRestore();
  }
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
  expect(ids(42, false)).toEqual(ids(42, false));
  expect(crypto.randomUUID).toBe(originalDefault);
  expect(randomUUID).toBe(originalNamed);
});
