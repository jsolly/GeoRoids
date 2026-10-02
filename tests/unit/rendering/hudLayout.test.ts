import { afterEach, expect, test, vi } from 'vitest';

import { VISUAL } from '../../../src/constants';
import {
  clearHudLayoutCache,
  computeHudLayout,
  hudLayoutForCanvas,
  refreshHudLayoutForCanvas,
} from '../../../src/rendering/hud/hudLayout';

afterEach(() => {
  clearHudLayoutCache();
  vi.restoreAllMocks();
  document.querySelector('#safe-area-probe')?.remove();
});

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

test('flight reuses HUD layout and rotation refreshes the safe-area anchors', () => {
  document.querySelector('#safe-area-probe')?.remove();
  const probe = document.createElement('div');
  probe.id = 'safe-area-probe';
  probe.style.paddingTop = '47px';
  document.body.append(probe);
  const styles = vi.spyOn(window, 'getComputedStyle');
  const portrait = { width: 390, height: 844 };
  const initial = refreshHudLayoutForCanvas(portrait);
  expect(initial.balance.y).toBe(55);
  for (let frame = 0; frame < 120; frame++) {
    expect(hudLayoutForCanvas(portrait)).toBe(initial);
  }
  expect(styles).toHaveBeenCalledTimes(1);
  probe.style.paddingTop = '0px';
  probe.style.paddingLeft = '47px';
  const landscape = refreshHudLayoutForCanvas({ width: 844, height: 390 });
  expect(landscape.balance).toEqual({ x: 55, y: 12 });
  expect(styles).toHaveBeenCalledTimes(2);
});

test('a synchronous safe-area edit moves the phone HUD without resizing or resetting its cache', () => {
  const probe = document.createElement('div');
  probe.id = 'safe-area-probe';
  document.body.append(probe);
  const viewport = { width: 390, height: 844 };
  const styles = vi.spyOn(window, 'getComputedStyle');
  const media = vi.spyOn(window, 'matchMedia');
  const initial = hudLayoutForCanvas(viewport);
  const mediaReads = media.mock.calls.length;
  for (let frame = 0; frame < 120; frame++) {
    expect(hudLayoutForCanvas(viewport)).toBe(initial);
  }
  expect(styles).toHaveBeenCalledTimes(1);
  expect(media).toHaveBeenCalledTimes(mediaReads);

  probe.style.padding = '47px 24px 34px 24px';
  const shifted = hudLayoutForCanvas(viewport);
  expect(shifted.balance).toEqual({ x: 32, y: 55 });
  expect(shifted.score).toEqual(shifted.balance);
  expect(shifted.kitNameY).toBe(initial.kitNameY + 43);
  expect(shifted.miniMap.x).toBe(initial.miniMap.x - 20);
  expect(shifted.miniMap.y).toBe(initial.miniMap.y - 30);
  expect(hudLayoutForCanvas(viewport)).toBe(shifted);
  expect(styles).toHaveBeenCalledTimes(2);

  probe.removeAttribute('style');
  const restored = hudLayoutForCanvas(viewport);
  expect(restored.balance).toEqual({ x: 12, y: 12 });
  expect(restored.miniMap).toEqual(initial.miniMap);
  expect(hudLayoutForCanvas(viewport)).toBe(restored);
  expect(styles).toHaveBeenCalledTimes(3);
});

test('replacing or removing the safe-area probe immediately replaces its cached HUD anchors', () => {
  const probe = document.createElement('div');
  probe.id = 'safe-area-probe';
  probe.style.paddingTop = '47px';
  document.body.append(probe);
  const viewport = { width: 390, height: 844 };
  const initial = hudLayoutForCanvas(viewport);
  expect(initial.balance.y).toBe(55);

  const replacement = document.createElement('div');
  replacement.id = probe.id;
  replacement.style.paddingLeft = '24px';
  probe.replaceWith(replacement);
  const replaced = hudLayoutForCanvas(viewport);
  expect(replaced.balance).toEqual({ x: 32, y: 12 });
  expect(hudLayoutForCanvas(viewport)).toBe(replaced);

  replacement.remove();
  const removed = hudLayoutForCanvas(viewport);
  expect(removed.balance).toEqual({ x: 12, y: 12 });
  expect(hudLayoutForCanvas(viewport)).toBe(removed);
  document.body.append(probe);
  expect(hudLayoutForCanvas(viewport).balance).toEqual({ x: 12, y: 55 });
});

test('safe-area classes change the phone anchors without a resize event', () => {
  const rule = document.createElement('style');
  rule.textContent = '#safe-area-probe.notched { padding-top: 47px; }';
  document.head.append(rule);
  const probe = document.createElement('div');
  probe.id = 'safe-area-probe';
  document.body.append(probe);
  try {
    const viewport = { width: 390, height: 844 };
    expect(hudLayoutForCanvas(viewport).balance.y).toBe(12);
    probe.className = 'notched';
    const notched = hudLayoutForCanvas(viewport);
    expect(notched.balance.y).toBe(55);
    expect(hudLayoutForCanvas(viewport)).toBe(notched);
    probe.removeAttribute('class');
    expect(hudLayoutForCanvas(viewport).balance.y).toBe(12);
  } finally {
    rule.remove();
  }
});

test('desktop 800x600 keeps the Wave1 compact cluster anchors', () => {
  const layout = computeHudLayout(
    { width: 800, height: 600 },
    { touchControls: false, safeArea: ZERO }
  );
  expect(layout.score).toEqual({ x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET });
  expect(layout.notificationY).toBe(12);
  expect(layout.leaderboard).toMatchObject({
    x: 800 - 180 - 16,
    y: 16,
    width: 180,
    maxRows: 10,
  });
  expect(layout.miniMap).toEqual({
    x: 800 - 16 - VISUAL.MINIMAP_SIZE,
    y: 600 - 16 - VISUAL.MINIMAP_SIZE,
    size: VISUAL.MINIMAP_SIZE,
  });
});

test('phone portrait keeps notices below the leaderboard and radar above the ability buttons', () => {
  const layout = computeHudLayout(
    { width: 390, height: 844 },
    { touchControls: true, safeArea: ZERO }
  );
  expect(layout.balance.x).toBeGreaterThanOrEqual(12);
  expect(layout.balance.y).toBeGreaterThanOrEqual(12);
  expect(layout.miniMap.x + layout.miniMap.size).toBeLessThanOrEqual(390 - 12);
  expect(layout.miniMap.y + layout.miniMap.size).toBeLessThanOrEqual(844 - 12 - 112);
  expect(layout.leaderboard.maxRows).toBe(3);
  expect(layout.notificationY).toBeGreaterThan(
    layout.leaderboard.y + layout.leaderboard.rowHeight * layout.leaderboard.maxRows
  );
  expect(layout.notificationY).toBeGreaterThan(layout.kitNameY + 18);
});

test('phone landscape keeps the radar below the top action buttons', () => {
  const layout = computeHudLayout(
    { width: 844, height: 390 },
    { touchControls: true, safeArea: ZERO }
  );
  expect(layout.miniMap.y).toBeGreaterThan(layout.score.y + 28);
  expect(layout.miniMap.x + layout.miniMap.size).toBe(844 - layout.padRight);
  expect(layout.leaderboard.maxRows).toBe(3);
});

test('safe-area insets push the bank balance off the notch', () => {
  const layout = computeHudLayout(
    { width: 390, height: 844 },
    { touchControls: true, safeArea: { top: 47, right: 0, bottom: 34, left: 0 } }
  );
  expect(layout.balance.y).toBeGreaterThanOrEqual(47);
  expect(layout.padBottom).toBeGreaterThanOrEqual(34);
});
