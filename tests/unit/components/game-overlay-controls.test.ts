import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import GameOverlay from '../../../src/components/game/GameOverlay.svelte';

let overlay: ReturnType<typeof mount> | undefined;
let mobile = false;
let breakpointListener: (() => void) | undefined;
const addBreakpoint = vi.fn();
const removeBreakpoint = vi.fn();

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
  mobile = false;
  breakpointListener = undefined;
  addBreakpoint.mockReset();
  removeBreakpoint.mockReset();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(max-width: 639px)' && mobile;
    },
    media: query,
    addEventListener: (_event: string, listener: () => void) => {
      if (query === '(max-width: 639px)') {
        addBreakpoint(listener);
        breakpointListener = listener;
      }
    },
    removeEventListener: (_event: string, listener: () => void) => {
      if (query === '(max-width: 639px)') {
        removeBreakpoint(listener);
      }
    },
  }));
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
        render: () => '<div><button id="overlay-action">Equip Tow Cable</button></div>',
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
  expect(dialog.dataset['slot']).toBe('dialog-content');
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

test('an open overlay becomes a mobile sheet without closing and releases its breakpoint listener', async () => {
  const { onclose } = await start();
  element('#overlay-action', HTMLButtonElement).focus();
  mobile = true;
  breakpointListener?.();
  await settle();
  expect(element('[role="dialog"]', HTMLDivElement).dataset['slot']).toBe('sheet-content');
  expect(document.activeElement).toBe(document.querySelector('#overlay-action'));
  expect(onclose).not.toHaveBeenCalled();
  mobile = false;
  breakpointListener?.();
  await settle();
  expect(element('[role="dialog"]', HTMLDivElement).dataset['slot']).toBe('dialog-content');
  expect(document.activeElement).toBe(document.querySelector('#overlay-action'));
  expect(onclose).not.toHaveBeenCalled();
  if (!overlay) {
    throw new Error('Overlay missing');
  }
  await unmount(overlay);
  overlay = undefined;
  expect(addBreakpoint).toHaveBeenCalledTimes(1);
  expect(removeBreakpoint).toHaveBeenCalledExactlyOnceWith(addBreakpoint.mock.calls[0]?.[0]);
});
