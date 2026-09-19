import { afterEach, expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import {
  initializeTouchControls,
  syncTouchChrome,
  tickTouchControls,
} from '../../../src/input/touchControls';
import { setPlayView } from '../../../src/ui/uiUtils';

afterEach(() => {
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
  expect(document.body.classList.contains('touch-play')).toBe(true);
  expect(root?.hidden).toBe(false);
  expect(document.querySelector('#touch-stick')).toBeNull();
  expect(document.querySelector('#touch-fire')).toBeNull();
  expect(document.querySelector('#touch-ability')).toBeTruthy();
  expect(document.querySelector('#touch-boost')).toBeTruthy();
  expect(document.querySelector('#touch-shield')).toBeNull();
});

test('desktop-sized play view keeps boost visible while hiding touch-only ability chrome', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);
  expect(document.body.classList.contains('touch-play')).toBe(false);
  const root = document.querySelector<HTMLElement>('#touch-controls');
  expect(root?.hidden).toBe(false);
  expect(root?.classList.contains('is-desktop')).toBe(true);
  expect(document.querySelector('#touch-boost')).toBeTruthy();
});

test('boost chrome exposes active drain, empty tank, and interruptible recharge state', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);

  const player = new Player({
    id: 'boost-chrome-player',
    name: 'Boost Tester',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const boost = document.querySelector<HTMLButtonElement>('#touch-boost');
  expect(boost).toBeTruthy();

  player.ship.boost = { phase: 'active', charge: 0.64 };
  tickTouchControls(player);
  expect(boost?.textContent).toBe('BOOSTING 64%');
  expect(boost?.getAttribute('aria-label')).toContain('Stop boost');
  expect(boost?.disabled).toBe(false);
  expect(boost?.style.getPropertyValue('--boost-charge')).toBe('0.640');
  expect(boost?.dataset['boostPhase']).toBe('active');

  player.ship.boost = { phase: 'exhausted', charge: 0.24 };
  tickTouchControls(player);
  expect(boost?.textContent).toBe('RECHARGING 24%');
  expect(boost?.getAttribute('aria-disabled')).toBe('false');
  expect(boost?.disabled).toBe(false);
  expect(boost?.classList.contains('is-recharging')).toBe(true);
  expect(boost?.classList.contains('is-exhausted')).toBe(false);
  expect(boost?.getAttribute('aria-label')).toBe('Start boost, 24% charge');

  player.ship.boost = { phase: 'exhausted', charge: 0 };
  tickTouchControls(player);
  expect(boost?.disabled).toBe(true);
  expect(boost?.getAttribute('aria-label')).toBe('Boost empty, recharging');

  player.ship.boost = { phase: 'idle', charge: 0.48 };
  tickTouchControls(player);
  expect(boost?.textContent).toBe('RECHARGING 48%');
  expect(boost?.getAttribute('aria-disabled')).toBe('false');
  expect(boost?.disabled).toBe(false);
  expect(boost?.dataset['boostPhase']).toBe('idle');
});
