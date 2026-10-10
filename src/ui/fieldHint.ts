export type FieldHintId = 'furnace-travel-prompt' | 'furnace-build-hint' | 'cargo-full-hint';

interface FieldHintContent {
  text?: string;
  action?: { label: string; run: () => void };
}

export interface FieldHintView {
  readonly id: FieldHintId;
  readonly text: string;
  readonly actionLabel: string | null;
}

const hints = new Map<FieldHintId, { view: FieldHintView; run?: () => void }>();
const subscribers = new Set<() => void>();
let current: readonly FieldHintView[] = Object.freeze([]);

function publish(): void {
  current = Object.freeze([...hints.values()].map(({ view }) => view));
  for (const listener of subscribers) {
    listener();
  }
}

/** Only the three contextual hint IDs can enter the bounded presentation. */
export function setFieldHint(
  id: FieldHintId,
  visible: boolean,
  content: FieldHintContent = {}
): void {
  const previous = hints.get(id);
  if (!visible) {
    if (hints.delete(id)) {
      publish();
    }
    return;
  }
  const view = Object.freeze({
    id,
    text: (content.text ?? '').slice(0, 500),
    actionLabel: content.action ? content.action.label.slice(0, 100) : null,
  });
  // Replace the command even when its visible label has not changed.
  hints.set(id, { view, ...(content.action ? { run: content.action.run } : {}) });
  if (
    !previous ||
    previous.view.text !== view.text ||
    previous.view.actionLabel !== view.actionLabel
  ) {
    publish();
  }
}

export function readFieldHints(): readonly FieldHintView[] {
  return current;
}

export function subscribeFieldHints(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function activateFieldHint(id: FieldHintId): void {
  hints.get(id)?.run?.();
}

export function hideFieldHints(): void {
  if (hints.size) {
    hints.clear();
    publish();
  }
}
