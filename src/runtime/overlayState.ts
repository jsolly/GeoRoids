export type GameOverlayId = 'inventory' | 'town-store' | 'universe-map';
type OverlayListener = (next: GameOverlayId | null, previous: GameOverlayId | null) => void;

let current: GameOverlayId | null = null;
const listeners = new Set<OverlayListener>();

export function getOpenGameOverlay(): GameOverlayId | null {
  return current;
}

export function isGameOverlayOpen(id: GameOverlayId): boolean {
  return current === id;
}

/** One synchronous transition gates input before either old or new chrome paints. */
export function openGameOverlay(id: GameOverlayId): void {
  transition(id);
}

/** A stale panel cannot close a different overlay that has replaced it. */
export function closeGameOverlay(id: GameOverlayId): void {
  if (current === id) {
    transition(null);
  }
}

export function subscribeGameOverlay(listener: OverlayListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function transition(next: GameOverlayId | null): void {
  if (next === current) {
    return;
  }
  const previous = current;
  current = next;
  for (const listener of listeners) {
    listener(next, previous);
  }
}
