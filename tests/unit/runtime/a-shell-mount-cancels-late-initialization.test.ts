import { describe, expect, test, vi } from 'vitest';
import { mountRuntime, type RuntimeMountState } from '../../../src/runtime/runtimeMount';
import { logger } from '../../../src/utils/Logger';

interface DiagnosticRecord {
  category?: string;
  message?: string;
  context?: { error?: { message?: string; stack?: string } | string };
}

/** The newest record the in-page diagnostics trail holds, as a report would carry it. */
function lastDiagnostic(): DiagnosticRecord {
  const line = logger.getRecentDiagnostics().at(-1);
  if (line === undefined) {
    throw new Error('Expected a diagnostic record, but the trail was empty.');
  }
  return JSON.parse(line) as DiagnosticRecord;
}

function deferred<Value>() {
  let resolve: (value: Value) => void = () => {
    throw new Error('Promise is not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('Promise is not initialized');
  };
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve();
  }
}

describe('shell runtime startup', () => {
  test('aborts a pending mount and disposes a late runtime without publishing ready', async () => {
    const result = deferred<{ dispose(): void }>();
    const dispose = vi.fn();
    const states: string[] = [];
    let signal: AbortSignal | undefined;
    const mount = mountRuntime(
      (current) => {
        signal = current;
        return result.promise;
      },
      (state) => states.push(state.kind)
    );
    await settle();
    expect(signal?.aborted).toBe(false);
    mount.dispose();
    mount.dispose();
    expect(signal?.aborted).toBe(true);
    result.resolve({ dispose });
    await settle();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['loading']);
  });

  test('retries failed initialization once and tears down the accepted result once', async () => {
    const dispose = vi.fn();
    const initialize = vi
      .fn<(signal: AbortSignal) => Promise<{ dispose(): void }>>()
      .mockRejectedValueOnce(new Error('GPU unavailable'))
      .mockResolvedValueOnce({ dispose });
    const states: RuntimeMountState<{ dispose(): void }>[] = [];
    const mount = mountRuntime(initialize, (state) => states.push(state));
    mount.retry();
    await settle();
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ kind: 'loading' }, { kind: 'error', message: 'GPU unavailable' }]);

    // The panel shows only `message`, so the stack used to go nowhere at all.
    // Nothing held the record that replaced that in place: dropping the cause
    // argument, swapping the two context arguments, or deleting the call
    // outright all left this suite green. It is more than a console line --
    // ERROR records enter the in-page diagnostics trail, which
    // `clientDiagnostics` ships as `recentLogs` in every submitted report, so
    // this is both what an operator reads and part of what a player sends.
    const failed = lastDiagnostic();
    expect(failed.category).toBe('RUNTIME');
    expect(failed.message).toBe('Game runtime failed to initialize');
    expect(failed.context?.error).toMatchObject({
      message: 'GPU unavailable',
      stack: expect.stringContaining('GPU unavailable'),
    });

    mount.retry();
    mount.retry();
    await settle();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(states.map((state) => state.kind)).toEqual(['loading', 'error', 'loading', 'ready']);
    mount.dispose();
    mount.dispose();
    mount.retry();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  test('a startup failure that is not an Error still records its value and a readable panel message', async () => {
    const states: RuntimeMountState<{ dispose(): void }>[] = [];
    // A rejected dynamic import does not always carry an Error -- a stale chunk
    // URL served to a cached index can reject with a plain value -- and that
    // path takes the other half of the call, which nothing exercised.
    const mount = mountRuntime(
      () => Promise.reject('chunk 4f21a9 is no longer served'),
      (state) => states.push(state)
    );
    await settle();

    expect(states).toEqual([
      { kind: 'loading' },
      { kind: 'error', message: 'The game could not initialize.' },
    ]);
    const failed = lastDiagnostic();
    expect(failed.category).toBe('RUNTIME');
    expect(failed.message).toBe('Game runtime failed to initialize');
    // No Error to carry, so the raw value travels as context instead, where it
    // is still recoverable from a submitted report.
    expect(JSON.stringify(failed.context)).toContain('chunk 4f21a9 is no longer served');
    mount.dispose();
  });

  test('never invokes initialization if the shell unmounts before import begins', async () => {
    const initialize = vi.fn(async () => ({ dispose: vi.fn() }));
    const present = vi.fn();
    const mount = mountRuntime(initialize, present);
    mount.dispose();
    await settle();
    expect(initialize).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledExactlyOnceWith({ kind: 'loading' });
  });
});
