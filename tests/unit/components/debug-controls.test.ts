import { flushSync, mount, tick, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import DebugPanel from '../../../src/components/game/DebugPanel.svelte';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { GameStateManager } from '../../../src/core/services/GameStateManager';
import { InputManager } from '../../../src/core/services/InputManager';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { controlSources } from '../../../src/input/controlSources';
import { getPressedKeysForPlayer } from '../../../src/input/keybindings';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { createDebugPresentation } from '../../../src/runtime/debugPresentation';
import { getOpenGameOverlay, openGameOverlay } from '../../../src/runtime/overlayState';
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
    if (model != null) {
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
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  logger.debug('TEST', 'normal route suppresses debug');
  expect(debug).not.toHaveBeenCalled();
  debug.mockRestore();
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
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logger.debug('TEST', 'route debug');
  logger.info('TEST', 'route info');
  logger.warn('TEST', 'route warning');
  expect(debug).toHaveBeenCalledTimes(level === LogLevel.DEBUG ? 1 : 0);
  expect(info).toHaveBeenCalledTimes(level >= LogLevel.INFO ? 1 : 0);
  expect(warn).toHaveBeenCalledOnce();
  debug.mockRestore();
  info.mockRestore();
  warn.mockRestore();
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

test('a debug pilot starts collapsed and a fresh runtime preserves the chosen expansion', () => {
  start();
  expect(model?.read(false)?.hudHidden).toBe(true);
  model?.toggleHud();
  expect(model?.read(false)?.hudHidden).toBe(false);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.debugHudHidden)).toBe('false');
  model?.dispose();
  model = createDebugPresentation(() => {});
  expect(model.read(false)?.hudHidden).toBe(false);
  model.toggleHud();
  expect(model.read(false)?.hudHidden).toBe(true);
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
      await pending;
    } else {
      reject(new Error('Clipboard access denied'));
      await expect(pending).rejects.toThrow('Clipboard access denied');
    }
    await tick();
    flushSync();
    expect(document.activeElement).toBe(input);
    expect(vi.getTimerCount()).toBe(timers);
    expect(target?.querySelector('textarea')).toBeNull();
  }
);

test('the bug button starts collapsed and toggles the entire diagnostics panel', () => {
  start('/debug', true);
  const toggle = target?.querySelector<HTMLButtonElement>('#debug-hud-toggle');
  const hud = target?.querySelector<HTMLElement>('#debug-hud');
  expect(hud?.hidden).toBe(true);
  expect(toggle?.getAttribute('aria-label')).toBe('Show diagnostics');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  expect(toggle?.getAttribute('aria-controls')).toBe(hud?.id);
  expect(toggle?.querySelector('svg')).not.toBeNull();
  toggle?.click();
  flushSync();
  expect(hud?.hidden).toBe(false);
  expect(toggle?.getAttribute('aria-label')).toBe('Hide diagnostics');
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(hud?.querySelector('#debug-hud-player-id')).not.toBeNull();
  expect(hud?.querySelector('#copy-debug-diagnostics')).not.toBeNull();
  expect(hud?.textContent).toContain('Report a problem');
  toggle?.click();
  flushSync();
  expect(hud?.hidden).toBe(true);
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
});

test('Copy diagnostics releases held fire and isolates cold presses', () => {
  const network = ConnectionManager.getInstance();
  const players = PlayerManager.getInstance({
    networkPort: network,
    combatNetwork: network.combatNetwork,
  });
  const pilot = new Player({ id: 'debug-pilot', name: 'Pilot', type: 'local' });
  const local = vi.spyOn(players, 'getLocalPlayer').mockReturnValue(pilot);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const gameState = GameStateManager.getInstance();
  const wasRunning = gameState.getIsGameRunning();
  const previousOverlay = getOpenGameOverlay();
  const previousSources = { ...controlSources };
  const manager = InputManager.getInstance();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const scope = new AbortController();
  const keys = vi.fn();
  try {
    start('/debug', true);
    target?.querySelector<HTMLButtonElement>('#debug-hud-toggle')?.click();
    flushSync();
    const button = target?.querySelector<HTMLButtonElement>('#copy-debug-diagnostics');
    if (!button) {
      throw new Error('Missing in-play Copy diagnostics button');
    }
    expect(target?.querySelector<HTMLElement>('#debug-hud')?.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(getOpenGameOverlay()).toBeNull();
    gameState.setIsGameRunning(true);
    manager.initializeListeners(canvas);
    document.addEventListener('keydown', keys, { signal: scope.signal });
    button.focus();
    expect(document.activeElement).toBe(button);
    for (const code of ['Space', 'Enter']) {
      const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(keys).not.toHaveBeenCalled();
    expect(pilot.ship.lasers).toHaveLength(0);
    expect(getPressedKeysForPlayer(pilot).has('Space')).toBe(false);
    scope.abort();
    button.blur();

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(pilot.ship.lasers).toHaveLength(1);
    expect(getPressedKeysForPlayer(pilot).has('Space')).toBe(true);
    expect(pilot.ship.canShoot).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    expect.soft(getPressedKeysForPlayer(pilot).has('Space')).toBe(false);
    expect.soft(pilot.ship.canShoot).toBe(true);
    button.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    expect(pilot.ship.lasers).toHaveLength(2);
  } finally {
    scope.abort();
    try {
      manager.detachRuntime();
    } finally {
      gameState.setIsGameRunning(wasRunning);
      if (previousOverlay !== null) {
        openGameOverlay(previousOverlay);
      }
      Object.assign(controlSources, previousSources);
      local.mockRestore();
      clock.mockRestore();
      canvas.remove();
    }
  }
});
