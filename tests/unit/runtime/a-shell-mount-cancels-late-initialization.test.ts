import { describe, expect, test, vi } from 'vitest';
import { mountRuntime, type RuntimeMountState } from '../../../src/runtime/runtimeMount';

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
