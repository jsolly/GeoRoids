import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { debugIsOn, LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import {
  applyDebugPreference,
  mountDebugIdentity,
  resetDebugIdentityForTests,
} from '../../../src/ui/debugIdentity';
import { setPlayView } from '../../../src/ui/uiUtils';
import { getClientLogContext } from '../../../src/utils/clientLogContext';
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

test('an in-play Debug chip shows the same playerId after join and hides when Debug is off', () => {
  applyDebugPreference(true);
  window.dispatchEvent(
    new CustomEvent('playerIdentityChanged', {
      detail: { playerId: JOINED_ID },
    })
  );

  expect(document.querySelector<HTMLElement>('#debug-play-chip')?.hidden).toBe(true);

  setPlayView(true);

  const chip = document.querySelector<HTMLElement>('#debug-play-chip');
  expect(chip?.hidden).toBe(false);
  expect(document.querySelector('#debug-play-chip-id')?.textContent).toBe(JOINED_ID);

  setPlayView(false);
  expect(document.querySelector<HTMLElement>('#debug-play-chip')?.hidden).toBe(true);

  setPlayView(true);
  applyDebugPreference(false);
  expect(document.querySelector<HTMLElement>('#debug-play-chip')?.hidden).toBe(true);
});
