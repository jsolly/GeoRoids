import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import DebugPanel from '../../../src/components/game/DebugPanel.svelte';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { createDebugPresentation } from '../../../src/runtime/debugPresentation';
import { getClientLogContext } from '../../../src/utils/clientLogContext';
import { logger } from '../../../src/utils/Logger';
import { LogLevel } from '../../../src/utils/logLevel';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

let panel: ReturnType<typeof mount> | undefined;
let model: ReturnType<typeof createDebugPresentation> | undefined;
let target: HTMLDivElement | undefined;

afterEach(async () => {
  if (panel) {
    await unmount(panel);
  }
  panel = undefined;
  model?.dispose();
  model = undefined;
  target?.remove();
  target = undefined;
  window.history.replaceState(null, '', '/');
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugHudHidden);
  resetSafeStorage();
  logger.applyConfiguredLogLevel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(path = '/debug', inPlay = false) {
  window.history.replaceState(null, '', path);
  const update = vi.fn(() => {
    if (model) {
      view.set(model.read(false));
    }
  });
  model = createDebugPresentation(update);
  const view = writable(model.read(false));
  const state = fromStore(view);
  target = document.createElement('div');
  document.body.append(target);
  const initial = state.current;
  if (initial) {
    panel = mount(DebugPanel, {
      target,
      props: {
        get view() {
          return state.current ?? initial;
        },
        inPlay,
        ontoggle: model.toggleHud,
        diagnostics: model.diagnostics,
      },
    });
    flushSync();
  }
  return { update, view };
}

test('a normal pilot never sees diagnostics despite old saved debug preferences', () => {
  localStorage.setItem('debugOn', 'true');
  localStorage.setItem('debugLogLevel', 'debug');
  start('/?log-level=debug');
  expect(model?.read(false)).toBeNull();
  expect(target?.querySelector('#debug-identity')).toBeNull();
  expect(logger.getLogLevel()).toBe(LogLevel.INFO);
});

test.each([
  ['/debug?log-level=debug', LogLevel.DEBUG],
  ['/debug?log-level=warn', LogLevel.WARN],
  ['/debug?log-level=info', LogLevel.INFO],
  ['/debug?log-level=invalid', LogLevel.INFO],
  ['/debug?log-level=error', LogLevel.INFO],
  ['/debug-other?log-level=debug', LogLevel.INFO],
] as const)('a pilot visiting %s receives the supported route log level', (path, level) => {
  start(path);
  expect(logger.getLogLevel()).toBe(level);
});

test('a debug pilot sees its page identity before joining and copies its accepted player identity', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  start('/debug/');
  expect(target?.querySelector<HTMLInputElement>('#debug-session-id')?.value).toBe(
    getClientLogContext().sessionId
  );
  expect(target?.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.disabled).toBe(true);
  window.dispatchEvent(
    new CustomEvent('playerIdentityChanged', { detail: { playerId: 'joined-pilot' } })
  );
  flushSync();
  expect(target?.querySelector<HTMLInputElement>('#debug-player-id')?.value).toBe('joined-pilot');
  target?.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('joined-pilot'));
});

test('a debug pilot hides metrics and a fresh runtime preserves the preference', () => {
  start();
  model?.toggleHud();
  expect(model?.read(false)?.hudHidden).toBe(true);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.debugHudHidden)).toBe('true');
  model?.dispose();
  model = createDebugPresentation(() => {});
  expect(model.read(false)?.hudHidden).toBe(true);
  model.toggleHud();
  expect(model.read(false)?.hudHidden).toBe(false);
});

test.each(['resolve', 'reject'] as const)(
  'a late clipboard %s cannot focus controls or create timers after unmount',
  async (outcome) => {
    vi.useFakeTimers();
    let accept = () => {};
    let reject = (_error: Error) => {};
    const pending = new Promise<void>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => pending } });
    start();
    const button = target?.querySelector<HTMLButtonElement>('#copy-debug-session-id');
    button?.click();
    if (panel) {
      await unmount(panel);
    }
    panel = undefined;
    const input = document.createElement('input');
    target?.append(input);
    input.focus();
    const timers = vi.getTimerCount();
    if (outcome === 'resolve') {
      accept();
    } else {
      reject(new Error('Clipboard access denied'));
    }
    for (let turn = 0; turn < 8; turn++) {
      await Promise.resolve();
    }
    flushSync();
    expect(document.activeElement).toBe(input);
    expect(vi.getTimerCount()).toBe(timers);
    expect(target?.querySelector('textarea')).toBeNull();
  }
);

test('the in-flight diagnostics toggle hides and restores the actual metric panel', () => {
  start('/debug', true);
  const toggle = target?.querySelector<HTMLButtonElement>('#debug-hud-toggle');
  const hud = target?.querySelector<HTMLFieldSetElement>('#debug-hud');
  expect(hud?.hidden).toBe(false);
  toggle?.click();
  flushSync();
  expect(hud?.hidden).toBe(true);
  expect(toggle?.textContent).toBe('Show HUD');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  toggle?.click();
  flushSync();
  expect(hud?.hidden).toBe(false);
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
});
