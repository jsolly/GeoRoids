import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import GameOverlay from '../../../src/components/game/GameOverlay.svelte';

let overlay: ReturnType<typeof mount> | undefined;
let viewport: EventTarget & {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};
let addViewport: ReturnType<typeof vi.spyOn>;
let removeViewport: ReturnType<typeof vi.spyOn>;

async function settle() {
  flushSync();
  await Promise.resolve();
  await vi.runAllTimersAsync();
  flushSync();
  await Promise.resolve();
}

function element<T extends Element>(selector: string, type: { new (...args: never[]): T }): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`Missing ${selector}`);
  }
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<button id="opener">Inventory</button><canvas id="flight" tabindex="-1"></canvas>';
  viewport = Object.assign(new EventTarget(), {
    width: 1280,
    height: 900,
    offsetLeft: 0,
    offsetTop: 0,
  });
  addViewport = vi.spyOn(viewport, 'addEventListener');
  removeViewport = vi.spyOn(viewport, 'removeEventListener');
  vi.stubGlobal('visualViewport', viewport);
});
afterEach(async () => {
  if (overlay) {
    await unmount(overlay);
  }
  overlay = undefined;
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function start(
  closeFocusTarget?: () => HTMLElement | null,
  restoreFocus = true,
  fallbackFocusTarget?: () => HTMLElement | null
) {
  const open = writable(false);
  const state = fromStore(open);
  const onclose = vi.fn(() => open.set(false));
  overlay = mount(GameOverlay, {
    target: document.body,
    props: {
      get open() {
        return state.current;
      },
      title: 'Inventory',
      description: 'Choose equipment for your ship.',
      onclose,
      closeFocusTarget,
      restoreFocus,
      fallbackFocusTarget,
      children: createRawSnippet(() => ({
        render: () =>
          '<div><textarea id="overlay-draft"></textarea><button id="overlay-action">Equip Tow Cable</button></div>',
      })),
    },
  });
  await settle();
  element('#opener', HTMLButtonElement).focus();
  open.set(true);
  await settle();
  return { open, onclose };
}

test('desktop close and Escape request a controlled close and restore focus to the opener', async () => {
  const { open, onclose } = await start();
  const dialog = element('[role="dialog"]', HTMLDivElement);
  const labelledBy = dialog.getAttribute('aria-labelledby');
  const describedBy = dialog.getAttribute('aria-describedby');
  expect(labelledBy && document.querySelector(`[id="${labelledBy}"]`)?.textContent).toBe(
    'Inventory'
  );
  expect(describedBy && document.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(
    'Choose equipment for your ship.'
  );
  onclose.mockImplementationOnce(() => {});
  element('[aria-label="Close Inventory"]', HTMLButtonElement).click();
  expect(onclose).toHaveBeenCalledTimes(1);
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  element('[aria-label="Close Inventory"]', HTMLButtonElement).click();
  expect(onclose).toHaveBeenCalledTimes(2);
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('#opener'));
  open.set(true);
  await settle();
  element('#overlay-action', HTMLButtonElement).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  await settle();
  expect(onclose).toHaveBeenCalledTimes(3);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('#opener'));
});

test('a return-to-flight intent overrides opener restoration with the canvas destination', async () => {
  await start(() => document.querySelector<HTMLCanvasElement>('#flight'));
  element('[aria-label="Close Inventory"]', HTMLButtonElement).click();
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('#flight'));
});

test('an overlay handoff suppresses restoration to the previous modal opener', async () => {
  await start(undefined, false);
  const restoreOpener = vi.spyOn(element('#opener', HTMLButtonElement), 'focus');
  element('[aria-label="Close Inventory"]', HTMLButtonElement).click();
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(restoreOpener).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(document.querySelector('#opener'));
});

test.each(['hidden', 'inert', 'disabled', 'removed', 'css-hidden'])(
  'a %s opener falls back to the connected playfield after dismissal',
  async (state) => {
    await start(undefined, true, () => document.querySelector<HTMLCanvasElement>('#flight'));
    const opener = element('#opener', HTMLButtonElement);
    if (state === 'hidden') {
      opener.hidden = true;
    } else if (state === 'inert') {
      opener.setAttribute('inert', '');
    } else if (state === 'disabled') {
      opener.disabled = true;
    } else if (state === 'removed') {
      opener.remove();
    } else {
      opener.style.display = 'none';
    }
    element('[aria-label="Close Inventory"]', HTMLButtonElement).click();
    await settle();
    expect(document.activeElement).toBe(document.querySelector('#flight'));
  }
);

test('a focused draft keeps the same dialog, textarea and caret across responsive layout changes', async () => {
  const { onclose } = await start();
  const dialog = element('[role="dialog"]', HTMLDivElement);
  const field = element('#overlay-draft', HTMLTextAreaElement);
  field.value = 'Keyboard stays open';
  field.focus();
  field.setSelectionRange(2, 8);
  Object.assign(viewport, { width: 390, height: 400, offsetLeft: 0, offsetTop: 60 });
  viewport.dispatchEvent(new Event('resize'));
  await settle();
  expect(element('[role="dialog"]', HTMLDivElement)).toBe(dialog);
  expect(element('#overlay-draft', HTMLTextAreaElement)).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(dialog.style.getPropertyValue('--overlay-viewport-height')).toBe('400px');
  expect(dialog.style.getPropertyValue('--overlay-viewport-top')).toBe('60px');
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 8]);
  Object.assign(viewport, { width: 1280, height: 900, offsetLeft: 10, offsetTop: 0 });
  viewport.dispatchEvent(new Event('scroll'));
  await settle();
  expect(element('[role="dialog"]', HTMLDivElement)).toBe(dialog);
  expect(element('#overlay-draft', HTMLTextAreaElement)).toBe(field);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('Keyboard stays open');
  expect([field.selectionStart, field.selectionEnd]).toEqual([2, 8]);
  expect(onclose).not.toHaveBeenCalled();
  expect(dialog.style.getPropertyValue('--overlay-viewport-width')).toBe('1280px');
  expect(dialog.style.getPropertyValue('--overlay-viewport-left')).toBe('10px');
  if (!overlay) {
    throw new Error('Missing overlay');
  }
  await unmount(overlay);
  overlay = undefined;
  expect(addViewport).toHaveBeenCalledTimes(2);
  expect(removeViewport).toHaveBeenCalledWith('resize', addViewport.mock.calls[0]?.[1]);
  expect(removeViewport).toHaveBeenCalledWith('scroll', addViewport.mock.calls[1]?.[1]);
});
