export interface PresentationSubscription<View> {
  subscribe(listener: (view: View) => void): () => void;
}

/** Project bounded UI values outside fixed simulation steps, never world entities. */
export function createPresentation<View>(
  project: () => View,
  equal: (previous: View, next: View) => boolean
): PresentationSubscription<View> & {
  sample(now: number): void;
  transition(): void;
  dispose(): void;
} {
  let view = project();
  let sampledAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  const listeners = new Set<(view: View) => void>();
  const publish = (): void => {
    if (disposed) {
      return;
    }
    const next = project();
    if (equal(view, next)) {
      return;
    }
    view = next;
    for (const listener of listeners) {
      listener(view);
    }
  };
  return {
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      listeners.add(listener);
      listener(view);
      return () => {
        listeners.delete(listener);
      };
    },
    sample(now) {
      if (disposed || now - sampledAt < 100) {
        return;
      }
      sampledAt = now;
      publish();
    },
    transition: publish,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
