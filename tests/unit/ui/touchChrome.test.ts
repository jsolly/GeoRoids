import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  initializeTouchControls,
  syncTouchChrome,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { setPlayView } from '../../../src/ui/uiUtils';

beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.classList.remove('in-play', 'touch-play');
  const root = document.querySelector<HTMLElement>('#touch-controls');
  if (root) {
    root.hidden = true;
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
});

test('setPlayView announces play chrome so the overlay can appear', () => {
  let seen = '';
  const on = () => {
    seen = 'on';
  };
  const off = () => {
    seen = 'off';
  };
  window.addEventListener('playViewOn', on);
  window.addEventListener('playViewOff', off);
  setPlayView(true);
  expect(seen).toBe('on');
  expect(document.body.classList.contains('in-play')).toBe(true);
  setPlayView(false);
  expect(seen).toBe('off');
  expect(document.body.classList.contains('touch-play')).toBe(false);
  window.removeEventListener('playViewOn', on);
  window.removeEventListener('playViewOff', off);
});

test('phone-sized play view unhides the full touch control overlay', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);
  const root = document.querySelector<HTMLElement>('#touch-controls');
  expect(root?.classList.contains('is-touch')).toBe(true);
  expect(root?.hidden).toBe(false);
  expect(document.querySelector('#touch-stick')).toBeNull();
  expect(document.querySelector('#touch-fire')).toBeNull();
  expect(document.querySelector('#touch-ability')).toBeTruthy();
  expect(document.querySelector('#touch-contour-lock')).toBeTruthy();
  expect(document.querySelector('#touch-shield')).toBeNull();
});

test('desktop-sized play view keeps Contour Lock visible while hiding touch-only ability chrome', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);
  expect(document.body.classList.contains('touch-play')).toBe(false);
  const root = document.querySelector<HTMLElement>('#touch-controls');
  expect(root?.hidden).toBe(false);
  expect(root?.classList.contains('is-desktop')).toBe(true);
  expect(document.querySelector('#touch-contour-lock')).toBeTruthy();
});

test('Contour Lock chrome shows unavailable, ready, and releasable states without a meter', () => {
  initializeTouchControls();
  document.body.classList.add('in-play');
  syncTouchChrome(true);
  const player = new Player({
    id: 'contour-chrome-player',
    name: 'Contour Tester',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const eligible = vi.spyOn(player.ship, 'canLockContour').mockReturnValue(false);
  const button = document.querySelector<HTMLButtonElement>('#touch-contour-lock');
  tickTouchControls(player);
  expect(button?.textContent).toBe('CONTOUR LOCK');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-label')).toContain('approach a contour');
  eligible.mockReturnValue(true);
  tickTouchControls(player);
  expect(button?.disabled).toBe(false);
  expect(button?.getAttribute('aria-label')?.toLowerCase()).toContain('contour lock');
  player.ship.contourLock = { height: 0.16, direction: 1 };
  eligible.mockReturnValue(false);
  tickTouchControls(player);
  expect(button?.textContent).toBe('RELEASE LOCK');
  expect(button?.getAttribute('aria-label')?.toLowerCase()).toContain('release lock');
  expect(button?.disabled).toBe(false);
  expect(button?.getAttribute('aria-pressed')).toBe('true');
  expect(button?.textContent).not.toContain('%');
  player.ship.releaseContourLock();
  tickTouchControls(player);
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-pressed')).toBe('false');
});
