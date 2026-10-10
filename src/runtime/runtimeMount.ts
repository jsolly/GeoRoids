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
