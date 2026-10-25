import { logger } from '../utils/Logger';

/** Startup owns only initialization. User gestures never wait on this promise. */
export type RuntimeMountState<Runtime> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly runtime: Runtime }
  | { readonly kind: 'error'; readonly message: string };

export function mountRuntime<Runtime extends { dispose(): void }>(
  initialize: (signal: AbortSignal) => Promise<Runtime>,
  present: (state: RuntimeMountState<Runtime>) => void
): { retry(): void; dispose(): void } {
  let disposed = false;
  let attempt: AbortController | undefined;
  let runtime: Runtime | undefined;
  let failed = false;

  const start = (): void => {
    attempt?.abort();
    const current = new AbortController();
    attempt = current;
    failed = false;
    present({ kind: 'loading' });
    void Promise.resolve()
      .then(() => {
        current.signal.throwIfAborted();
        return initialize(current.signal);
      })
      .then(
        (result) => {
          if (disposed || current.signal.aborted) {
            result.dispose();
            return;
          }
          runtime = result;
          present({ kind: 'ready', runtime: result });
        },
        (error: unknown) => {
          if (disposed || current.signal.aborted) {
            return;
          }
          failed = true;
          // Only `message` reached the panel, so the stack went nowhere at
          // all. A stale chunk URL served to a cached index rejects the dynamic
          // import here, which is exactly the case worth being able to read.
          //
          // This record stays in the browser: `Logger.forwardToServer` returns
          // early until a runtime attaches, and on both paths that reach here
          // none has -- the import can reject before `createGameRuntime` runs,
          // and its own failure path detaches before rethrowing. So the stack
          // reaches the console and the in-page diagnostics trail, not
          // `logs/client.log`. Forwarding before a runtime exists is a separate
          // change to the forwarder, not something this branch can assert.
          const cause = error instanceof Error ? error : undefined;
          logger.error(
            'RUNTIME',
            'Game runtime failed to initialize',
            cause,
            cause === undefined ? { error } : undefined
          );
          present({
            kind: 'error',
            message: error instanceof Error ? error.message : 'The game could not initialize.',
          });
        }
      );
  };

  start();
  return {
    retry() {
      if (!disposed && failed) {
        start();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      attempt?.abort();
      runtime?.dispose();
      runtime = undefined;
    },
  };
}
