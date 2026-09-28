import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LOGGING } from '../../../src/constants';
import { debugIsOn, LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import {
  applyDebugPreference,
  mountDebugIdentity,
  resetDebugIdentityForTests,
} from '../../../src/ui/debugIdentity';
import { setPlayView } from '../../../src/ui/uiUtils';
import { getClientLogContext } from '../../../src/utils/clientLogContext';
import { logger } from '../../../src/utils/Logger';
import { LogLevel } from '../../../src/utils/logLevel';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

const JOINED_ID = 'client-joined-ship';

function debugCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>('#debugPref');
  if (!checkbox) {
    throw new Error('expected #debugPref');
  }
  return checkbox;
}

function playerInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#debug-player-id');
  if (!input) {
    throw new Error('expected #debug-player-id');
  }
  return input;
}

function identityPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('#debug-identity');
  if (!panel) {
    throw new Error('expected #debug-identity');
  }
  return panel;
}

beforeEach(() => {
  resetDebugIdentityForTests();
  resetSafeStorage();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugOn);
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugLogLevel);
  logger.applyConfiguredLogLevel();
  document.body.classList.remove('debug-on', 'in-play');
  setPlayView(false);
  debugCheckbox().checked = false;
  identityPanel().hidden = true;
  const details = document.querySelector<HTMLDetailsElement>('#advanced-settings');
  if (details) {
    details.open = false;
  }
  mountDebugIdentity();
  applyDebugPreference(false);
});

afterEach(() => {
  resetDebugIdentityForTests();
  applyDebugPreference(false);
  setPlayView(false);
  document.body.classList.remove('debug-on', 'in-play');
  resetSafeStorage();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.debugOn);
  vi.unstubAllGlobals();
});

test('Debug stays off until the pilot opts in, then reveals copyable correlators', () => {
  expect(debugCheckbox().checked).toBe(false);
  expect(identityPanel().hidden).toBe(true);
  expect(playerInput().value).toBe('');

  debugCheckbox().checked = true;
  debugCheckbox().dispatchEvent(new Event('change'));

  expect(debugCheckbox().checked).toBe(true);
  expect(document.body.classList.contains('debug-on')).toBe(true);
  expect(document.querySelector<HTMLDetailsElement>('#advanced-settings')?.open).toBe(true);
  expect(identityPanel().hidden).toBe(false);
  expect(document.querySelector<HTMLInputElement>('#debug-session-id')?.value).toBe(
    getClientLogContext().sessionId
  );
  expect(playerInput().placeholder).toContain('Enter Game');
  expect(document.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.disabled).toBe(true);
});

test('the Debug checkbox is remembered across a hard refresh', () => {
  applyDebugPreference(true);
  expect(debugIsOn()).toBe(true);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.debugOn)).toBe('true');

  debugCheckbox().checked = false;
  document.body.classList.remove('debug-on');
  identityPanel().hidden = true;
  const details = document.querySelector<HTMLDetailsElement>('#advanced-settings');
  if (details) {
    details.open = false;
  }

  applyDebugPreference(debugIsOn());

  expect(debugCheckbox().checked).toBe(true);
  expect(document.body.classList.contains('debug-on')).toBe(true);
  expect(identityPanel().hidden).toBe(false);
});

test('a joined playerId is the copyable Debug value agents filter in Railway logs', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  applyDebugPreference(true);

  window.dispatchEvent(
    new CustomEvent('playerIdentityChanged', {
      detail: { playerId: JOINED_ID },
    })
  );

  expect(playerInput().value).toBe(JOINED_ID);
  expect(document.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.disabled).toBe(false);

  document.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.click();
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledWith(JOINED_ID);
  });
});

test('ops raise the client log level from Advanced Debug without a code change', () => {
  applyDebugPreference(false);
  const defaultLevel = logger.getLogLevel();
  applyDebugPreference(true);
  const select = document.querySelector<HTMLSelectElement>('#debug-log-level');
  if (!select) {
    throw new Error('expected #debug-log-level');
  }
  expect(select.value).toBe(LOGGING.GLOBAL_LOG_LEVEL);

  select.value = 'debug';
  select.dispatchEvent(new Event('change'));
  expect(logger.getLogLevel()).toBe(LogLevel.DEBUG);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.debugLogLevel)).toBe('debug');

  applyDebugPreference(false);
  expect(logger.getLogLevel()).toBe(defaultLevel);

  applyDebugPreference(true);
  expect(select.value).toBe('debug');
  expect(logger.getLogLevel()).toBe(LogLevel.DEBUG);
});
