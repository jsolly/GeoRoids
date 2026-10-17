import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createReportInputDiagnostics } from '../../../src/diagnostics/reportInputDiagnostics';

let field: HTMLTextAreaElement;
let diagnostics: ReturnType<typeof createReportInputDiagnostics> | undefined;

beforeEach(() => {
  field = document.createElement('textarea');
  document.body.append(field);
  field.focus();
});

afterEach(() => {
  diagnostics?.dispose();
  diagnostics = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('captured editing events reveal later cancellation without retaining entered text or keys', async () => {
  const textCanary = 'private report text 82f145';
  const keyCanary = 'private key 49a672';
  const typeCanary = 'private input type 18b562';
  const idCanary = 'private element id 62e014';
  field.id = idCanary;
  field.value = textCanary;
  diagnostics = createReportInputDiagnostics(field);
  const keydown = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: keyCanary,
    code: keyCanary,
    isComposing: true,
  });
  field.dispatchEvent(keydown);
  const before = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: typeCanary,
    data: textCanary,
    isComposing: true,
  });
  field.addEventListener('beforeinput', (event) => event.preventDefault(), { once: true });
  field.dispatchEvent(before);
  field.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertCompositionText',
      data: textCanary,
      isComposing: true,
    })
  );
  expect(diagnostics.read().events[1]?.defaultPrevented).toBe(false);
  await Promise.resolve();
  const result = diagnostics.read();
  expect(result.counts).toEqual({
    keydown: 1,
    beforeinput: 1,
    input: 1,
    compositionstart: 0,
    compositionupdate: 0,
    compositionend: 0,
    focusin: 0,
    focusout: 0,
  });
  expect(result.events).toEqual([
    {
      type: 'keydown',
      isTrusted: false,
      cancelable: true,
      defaultPrevented: false,
      composing: true,
      inputType: null,
      target: 'field',
      focus: 'field',
      valueLength: textCanary.length,
    },
    {
      type: 'beforeinput',
      isTrusted: false,
      cancelable: true,
      defaultPrevented: true,
      composing: true,
      inputType: 'other',
      target: 'field',
      focus: 'field',
      valueLength: textCanary.length,
    },
    {
      type: 'input',
      isTrusted: false,
      cancelable: false,
      defaultPrevented: false,
      composing: true,
      inputType: 'insertCompositionText',
      target: 'field',
      focus: 'field',
      valueLength: textCanary.length,
    },
  ]);
  for (const canary of [textCanary, keyCanary, typeCanary, idCanary]) {
    expect(JSON.stringify(result)).not.toContain(canary);
  }
  expect(keydown.defaultPrevented).toBe(false);
  expect(before.defaultPrevented).toBe(true);
  expect(field.value).toBe(textCanary);
});

test('composition and focus transitions distinguish the report field from other controls', async () => {
  diagnostics = createReportInputDiagnostics(field);
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    field.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: 'not retained' }));
  }
  const other = document.createElement('input');
  document.body.append(other);
  other.focus();
  other.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  other.blur();
  await Promise.resolve();
  const result = diagnostics.read();
  expect(result.counts.compositionstart).toBe(1);
  expect(result.counts.compositionupdate).toBe(1);
  expect(result.counts.compositionend).toBe(1);
  expect(result.counts.focusin).toBe(1);
  expect(result.counts.focusout).toBe(2);
  expect(result.events.find((event) => event.type === 'input')).toMatchObject({
    target: 'other',
    focus: 'other',
    inputType: 'insertFromPaste',
  });
  expect(result.field.focused).toBe(false);
  expect(result.focus).toBe('none');
  expect(JSON.stringify(result)).not.toContain('not retained');
});

test('long editing sessions keep complete counts and only the newest 24 metadata events', async () => {
  diagnostics = createReportInputDiagnostics(field);
  for (let length = 1; length <= 28; length++) {
    field.value = 'x'.repeat(length);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }
  await Promise.resolve();
  const result = diagnostics.read();
  expect(result.counts.input).toBe(28);
  expect(result.events.map((event) => event.valueLength)).toEqual(
    Array.from({ length: 24 }, (_, index) => index + 5)
  );
});

test('disposing stops document observation and invalidates queued cancellation updates', async () => {
  diagnostics = createReportInputDiagnostics(field);
  field.addEventListener('beforeinput', (event) => event.preventDefault(), { once: true });
  field.dispatchEvent(
    new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' })
  );
  const captured = diagnostics.read();
  diagnostics.dispose();
  await Promise.resolve();
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  field.blur();
  field.focus();
  for (const type of ['keydown', 'compositionstart', 'compositionupdate', 'compositionend']) {
    field.dispatchEvent(new Event(type, { bubbles: true }));
  }
  const disposed = diagnostics.read();
  expect(disposed.counts).toEqual(captured.counts);
  expect(disposed.events).toEqual(captured.events);
  expect(disposed.events[0]?.defaultPrevented).toBe(false);
});

test('reads copy observations and report the current field geometry and native editing state', async () => {
  field.value = 'hello';
  field.setSelectionRange(1, 4, 'backward');
  field.style.userSelect = 'text';
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 300, 120));
  vi.stubGlobal('visualViewport', { width: 800, height: 700 });
  diagnostics = createReportInputDiagnostics(field);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await Promise.resolve();
  const first = diagnostics.read();
  expect(first.field).toMatchObject({
    focused: true,
    disabled: false,
    readOnly: false,
    valueLength: 5,
    selection: { start: 1, end: 4, direction: 'backward' },
    userSelect: 'text',
    bounds: { width: 300, height: 120 },
  });
  expect(first.visualViewport).toEqual({ width: 800, height: 700 });
  first.counts.input = 99;
  const observation = first.events[0];
  if (!observation) {
    throw new Error('Missing observed edit');
  }
  observation.defaultPrevented = true;
  first.events.length = 0;
  first.field.selection.start = 99;
  first.field.bounds.width = 999;
  if (!first.visualViewport) {
    throw new Error('Missing visual viewport');
  }
  first.visualViewport.width = 999;
  const second = diagnostics.read();
  expect(second.counts.input).toBe(1);
  expect(second.events).toHaveLength(1);
  expect(second.events[0]?.defaultPrevented).toBe(false);
  expect(second.field.selection.start).toBe(1);
  expect(second.field.bounds.width).toBe(300);
  expect(second.visualViewport?.width).toBe(800);
  field.disabled = true;
  field.readOnly = true;
  expect(diagnostics.read().field).toMatchObject({ disabled: true, readOnly: true });
  vi.stubGlobal('visualViewport', undefined);
  expect(diagnostics.read().visualViewport).toBeNull();
});
