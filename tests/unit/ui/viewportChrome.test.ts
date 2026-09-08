import { expect, test } from 'vitest';

import {
  controlsHintFor,
  DESKTOP_CONTROLS_HINT,
  shouldUseTouchControls,
  TOUCH_CONTROLS_HINT,
  type ViewportQuery,
} from '../../../src/ui/viewportChrome';

const desktop: ViewportQuery = {
  width: 1440,
  height: 900,
  maxTouchPoints: 0,
  coarsePointer: false,
  hoverNone: false,
};

test('desktop mouse viewport keeps keyboard chrome', () => {
  expect(shouldUseTouchControls(desktop)).toBe(false);
  expect(controlsHintFor(desktop)).toBe(DESKTOP_CONTROLS_HINT);
});

test('phone portrait and landscape use the stick + fire hint', () => {
  const portrait = { ...desktop, width: 390, height: 844 };
  const landscape = { ...desktop, width: 844, height: 390 };
  expect(shouldUseTouchControls(portrait)).toBe(true);
  expect(shouldUseTouchControls(landscape)).toBe(true);
  expect(controlsHintFor(portrait)).toBe(TOUCH_CONTROLS_HINT);
});

test('800x600 stay-desktop so existing canvas tests keep the old HUD', () => {
  expect(shouldUseTouchControls({ ...desktop, width: 800, height: 600 })).toBe(false);
});

test('coarse pointer or hover-none shows touch controls on a large screen', () => {
  expect(shouldUseTouchControls({ ...desktop, coarsePointer: true })).toBe(true);
  expect(shouldUseTouchControls({ ...desktop, hoverNone: true })).toBe(true);
});

test('touchscreen tablet in the compact range shows the overlay', () => {
  expect(
    shouldUseTouchControls({
      width: 1024,
      height: 768,
      maxTouchPoints: 5,
      coarsePointer: false,
      hoverNone: false,
    })
  ).toBe(true);
});
