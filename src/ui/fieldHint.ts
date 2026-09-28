import './fieldHint.css';

interface FieldHintContent {
  /** Status line, e.g. a keyboard shortcut or an explanation. */
  text?: string;
  /** Optional tap target; clicks run the latest `run` passed for this hint. */
  action?: { label: string; run: () => void };
}

interface FieldHintElements {
  root: HTMLDivElement;
  line: HTMLSpanElement;
  button: HTMLButtonElement;
  run: (() => void) | undefined;
  visible: boolean;
  /** What the announcer last said for this hint; cleared with it on hide. */
  announced: string;
}

const hints = new Map<string, FieldHintElements>();
let announcer: HTMLDivElement | null = null;

/**
 * One always-rendered, visually hidden live region. The faded hint elements
 * are `visibility: hidden` between shows, which screen readers ignore, so
 * each show is announced here and cleared on hide to make the next show a
 * real change. It exists empty before any hint so the first one is heard.
 */
function ensureAnnouncer(): HTMLDivElement {
  if (!announcer?.isConnected) {
    announcer = document.createElement('div');
    announcer.className = 'field-hint-announcer';
    announcer.setAttribute('role', 'status');
    document.body.append(announcer);
  }
  return announcer;
}

function announce(hint: FieldHintElements, text: string): void {
  hint.announced = text;
  ensureAnnouncer().textContent = text;
}

function create(id: string): FieldHintElements {
  const root = document.createElement('div');
  root.id = id;
  root.className = 'field-hint';
  const line = document.createElement('span');
  // The announcer speaks for this line; do not read it twice.
  line.setAttribute('aria-hidden', 'true');
  const button = document.createElement('button');
  button.type = 'button';
  const elements: FieldHintElements = {
    root,
    line,
    button,
    run: undefined,
    visible: false,
    announced: '',
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    elements.run?.();
  });
  // Space/Enter on a focused hint button must not also fire or steer the ship.
  for (const type of ['keydown', 'keyup']) {
    button.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent && (event.code === 'Space' || event.code === 'Enter')) {
        event.stopPropagation();
      }
    });
  }
  root.append(button, line);
  document.body.append(root);
  hints.set(id, elements);
  return elements;
}

function hide(hint: FieldHintElements): void {
  hint.visible = false;
  // A fading button must not act on a stale context or keep focus.
  hint.run = undefined;
  if (hint.root.contains(document.activeElement)) {
    hint.button.blur();
  }
  hint.root.classList.remove('is-visible');
  if (announcer && announcer.textContent === hint.announced) {
    announcer.textContent = '';
  }
  hint.announced = '';
}

/**
 * One contextual line over the playfield. It fades in and out instead of
 * popping, and a faded hint is neither clickable nor focusable. Callers may
 * sync every frame; the DOM only changes when the hint does.
 */
export function setFieldHint(id: string, visible: boolean, content: FieldHintContent = {}): void {
  let hint = hints.get(id);
  if (!visible) {
    if (hint?.visible) {
      hide(hint);
    }
    return;
  }
  if (!hint?.root.isConnected) {
    hint = create(id);
  }
  const text = content.text ?? '';
  const label = content.action?.label ?? '';
  if (hint.line.textContent !== text) {
    hint.line.textContent = text;
  }
  hint.line.hidden = content.text === undefined;
  if (hint.button.textContent !== label) {
    hint.button.textContent = label;
  }
  hint.button.hidden = content.action === undefined;
  hint.run = content.action?.run;
  if (!hint.visible) {
    hint.visible = true;
    hint.root.classList.add('is-visible');
  }
  // New shows and prompts that change in place (travel → enter) are both heard.
  const spoken = content.text ?? label;
  if (hint.announced !== spoken) {
    announce(hint, spoken);
  }
}

export function hideFieldHints(): void {
  for (const hint of hints.values()) {
    if (hint.visible) {
      hide(hint);
    }
  }
}

if (typeof document !== 'undefined' && document.body) {
  ensureAnnouncer();
}
