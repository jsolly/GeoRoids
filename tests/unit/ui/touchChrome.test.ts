import { afterEach, expect, test } from 'vitest';
import { initializeTouchControls, syncTouchChrome } from '../../../src/input/touchControls';
import { setPlayView } from '../../../src/ui/uiUtils';

afterEach(() => {
  document.body.classList.remove('in-play', 'touch-play');
  const root = document.getElementById('touch-controls');
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
  const root = document.getElementById('touch-controls');
  expect(document.body.classList.contains('touch-play')).toBe(true);
  expect(root?.hidden).toBe(false);
  expect(document.getElementById('touch-stick')).toBeNull();
  expect(document.getElementById('touch-fire')).toBeTruthy();
  expect(document.getElementById('touch-ability')).toBeTruthy();
  expect(document.getElementById('touch-shield')).toBeTruthy();
});

test('desktop-sized play view keeps the overlay hidden', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);
  expect(document.body.classList.contains('touch-play')).toBe(false);
  expect(document.getElementById('touch-controls')?.hidden).toBe(true);
});
