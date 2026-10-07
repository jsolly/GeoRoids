import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { debugIsOn } from '../../../src/constants/user-preferences';
import {
  mountDebugIdentity,
  resetDebugIdentityForTests,
  syncDebugMode,
} from '../../../src/ui/debugIdentity';
import { setPlayView } from '../../../src/ui/uiUtils';
import { getClientLogContext } from '../../../src/utils/clientLogContext';
import { logger } from '../../../src/utils/Logger';
import { LogLevel } from '../../../src/utils/logLevel';
import { resetSafeStorage } from '../../../src/utils/safeStorage';

function visit(path: string): void {
  window.history.replaceState(null, '', path);
  mountDebugIdentity();
}

beforeEach(() => {
  resetDebugIdentityForTests();
  resetSafeStorage();
  setPlayView(false);
  visit('/');
});
afterEach(() => {
  visit('/');
  setPlayView(false);
  resetSafeStorage();
  vi.unstubAllGlobals();
});

test('a normal pilot never sees diagnostics even with old saved debug preferences', () => {
  localStorage.setItem('debugOn', 'true');
  localStorage.setItem('debugLogLevel', 'debug');
  visit('/?log-level=debug');
  expect(debugIsOn()).toBe(false);
  expect(document.body.classList.contains('debug-on')).toBe(false);
  expect(document.querySelector<HTMLElement>('#debug-identity')?.hidden).toBe(true);
  expect(logger.getLogLevel()).toBe(LogLevel.INFO);
  expect(document.querySelector('#debugPref')).toBeNull();
  expect(document.querySelector('#debug-log-level')).toBeNull();
});

test('a debug pilot sees page identity before joining and stays in debug on refresh', () => {
  visit('/debug');
  expect(debugIsOn()).toBe(true);
  expect(document.querySelector<HTMLElement>('#debug-identity')?.hidden).toBe(false);
  expect(document.querySelector<HTMLInputElement>('#debug-session-id')?.value).toBe(
    getClientLogContext().sessionId
  );
  expect(document.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.disabled).toBe(true);
  syncDebugMode();
  expect(document.body.classList.contains('debug-on')).toBe(true);
  expect(logger.getLogLevel()).toBe(LogLevel.INFO);
  visit('/debug/');
  expect(debugIsOn()).toBe(true);
});

test('a joined debug pilot can copy the same player ID displayed during play', async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  visit('/debug');
  window.dispatchEvent(
    new CustomEvent('playerIdentityChanged', { detail: { playerId: 'joined-pilot' } })
  );
  expect(document.querySelector<HTMLInputElement>('#debug-player-id')?.value).toBe('joined-pilot');
  expect(document.querySelector('#debug-hud-player-id')?.textContent).toBe('joined-pilot');
  expect(document.querySelector('#debug-hud-session-id')?.textContent).toBe(
    getClientLogContext().sessionId
  );
  document.querySelector<HTMLButtonElement>('#copy-debug-player-id')?.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('joined-pilot'));
});

test.each([
  ['/debug?log-level=debug', LogLevel.DEBUG],
  ['/debug?log-level=warn', LogLevel.WARN],
  ['/debug?log-level=info', LogLevel.INFO],
  ['/debug?log-level=invalid', LogLevel.INFO],
  ['/debug?log-level=error', LogLevel.INFO],
  ['/debug-other?log-level=debug', LogLevel.INFO],
])('a pilot visiting %s receives only the supported route log level', (url, level) => {
  visit(url);
  expect(logger.getLogLevel()).toBe(level);
  visit('/');
  expect(logger.getLogLevel()).toBe(LogLevel.INFO);
});
