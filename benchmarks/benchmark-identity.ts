import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

let owned = false;
const MAX_COUNTER = (1n << 62n) - 1n;

function initializationFailure(failures: unknown[]): AggregateError {
  return new AggregateError(failures, 'Benchmark UUID initialization failed', {
    cause: failures[0],
  });
}

/** Benchmark-only ownership of both default and named Node crypto bindings. */
export function ownBenchmarkIdentity(seed: number): {
  readonly source: string;
  release(): void;
} {
  if (owned) {
    throw new Error('Benchmark UUID identity is already owned');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error('Benchmark UUID seed must be a safe integer');
  }
  const original = crypto.randomUUID;
  if (original !== randomUUID) {
    throw new Error('Benchmark UUID default and named bindings must match before ownership');
  }
  // Every safe signed seed fits injectively in 54 of the first 60 payload bits.
  // The other 62 payload bits hold a non-wrapping ordinal, independent of RNG use.
  const seedHex = (BigInt(seed) + BigInt(Number.MAX_SAFE_INTEGER)).toString(16).padStart(15, '0');
  let counter = 0n;
  const controlled: typeof crypto.randomUUID = () => {
    if (counter === MAX_COUNTER) {
      throw new Error('Benchmark UUID ordinal exhausted');
    }
    counter++;
    const suffix = (counter | (1n << 63n)).toString(16);
    return `${seedHex.slice(0, 8)}-${seedHex.slice(8, 12)}-4${seedHex.slice(12)}-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
  };
  owned = true;
  try {
    crypto.randomUUID = controlled;
    syncBuiltinESMExports();
  } catch (error) {
    const failures = [error];
    try {
      crypto.randomUUID = original;
      syncBuiltinESMExports();
      owned = false;
    } catch (restoreError) {
      failures.push(restoreError);
    }
    if (failures.length > 1) {
      throw initializationFailure(failures);
    }
    throw error;
  }
  let released = false;
  return {
    source: 'benchmark-owned-seeded-node-crypto-randomUUID-v1',
    release() {
      if (released) {
        return;
      }
      crypto.randomUUID = original;
      syncBuiltinESMExports();
      owned = false;
      released = true;
    },
  };
}
