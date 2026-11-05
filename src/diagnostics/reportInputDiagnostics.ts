const EVENT_TYPES = [
  'keydown',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'focusin',
  'focusout',
] as const;
const EVENT_LIMIT = 24;

type EventType = (typeof EVENT_TYPES)[number];
type Target = 'field' | 'other' | 'none';

type InputObservation = {
  type: EventType;
  isTrusted: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  composing: boolean | null;
  inputType: ReturnType<typeof inputKind>;
  target: Target;
  focus: Target;
  valueLength: number;
};

function inputKind(event: Event) {
  if (!(event instanceof InputEvent)) {
    return null;
  }
  const kind = event.inputType;
  switch (kind) {
    case 'insertText':
    case 'insertCompositionText':
    case 'insertFromComposition':
    case 'deleteCompositionText':
    case 'insertReplacementText':
    case 'insertFromPaste':
    case 'insertFromDrop':
    case 'insertLineBreak':
    case 'insertParagraph':
    case 'deleteContentBackward':
    case 'deleteContentForward':
    case 'deleteWordBackward':
    case 'deleteWordForward':
    case 'deleteByCut':
    case 'historyUndo':
    case 'historyRedo':
      return kind;
    default:
      return 'other';
  }
}

function selectionStyle(value: string | undefined) {
  switch (value) {
    case undefined:
    case '':
      return null;
    case 'auto':
    case 'text':
    case 'none':
    case 'all':
    case 'contain':
      return value;
    default:
      return 'other';
  }
}

/** Observe the report editor without retaining entered text or identifying keys. */
export function createReportInputDiagnostics(field: HTMLTextAreaElement) {
  const document = field.ownerDocument;
  const counts = {
    keydown: 0,
    beforeinput: 0,
    input: 0,
    compositionstart: 0,
    compositionupdate: 0,
    compositionend: 0,
    focusin: 0,
    focusout: 0,
  };
  const events: InputObservation[] = [];
  let disposed = false;

  function targetKind(target: EventTarget | null): Target {
    return target === field ? 'field' : target === null ? 'none' : 'other';
  }

  function focusKind(): Target {
    const active = document.activeElement;
    return active === document.body || active === document.documentElement
      ? 'none'
      : targetKind(active);
  }

  const removeListeners = EVENT_TYPES.map((type) => {
    const observe = (event: Event) => {
      if (disposed) {
        return;
      }
      counts[type]++;
      const observation: InputObservation = {
        type,
        isTrusted: event.isTrusted,
        cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented,
        composing:
          event instanceof InputEvent || event instanceof KeyboardEvent ? event.isComposing : null,
        inputType: inputKind(event),
        target: targetKind(event.target),
        focus: focusKind(),
        valueLength: field.value.length,
      };
      events.push(observation);
      if (events.length > EVENT_LIMIT) {
        events.shift();
      }
      // Capture listeners run before target/bubble handlers can cancel editing.
      queueMicrotask(() => {
        if (!disposed) {
          observation.defaultPrevented = event.defaultPrevented;
        }
      });
    };
    document.addEventListener(type, observe, { capture: true, passive: true });
    return () => document.removeEventListener(type, observe, true);
  });

  return {
    read() {
      const window = document.defaultView;
      const style = window?.getComputedStyle(field);
      const bounds = field.getBoundingClientRect();
      const viewport = window?.visualViewport;
      return {
        counts: { ...counts },
        events: events.map((event) => ({ ...event })),
        field: {
          focused: document.activeElement === field,
          disabled: field.disabled,
          readOnly: field.readOnly,
          valueLength: field.value.length,
          selection: {
            start: field.selectionStart,
            end: field.selectionEnd,
            direction: field.selectionDirection,
          },
          userSelect: selectionStyle(style?.userSelect),
          webkitUserSelect: selectionStyle(style?.getPropertyValue('-webkit-user-select')),
          bounds: { width: bounds.width, height: bounds.height },
        },
        focus: focusKind(),
        visualViewport: viewport ? { width: viewport.width, height: viewport.height } : null,
      };
    },
    dispose() {
      disposed = true;
      for (const remove of removeListeners) {
        remove();
      }
    },
  };
}
