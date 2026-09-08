import { expect, test } from 'vitest';

import { VISUAL } from '../../../src/constants';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

test('desktop 800x600 keeps the Wave1 compact cluster anchors', () => {
  const layout = computeHudLayout(
    { width: 800, height: 600 },
    { touchControls: false, safeArea: ZERO }
  );
  expect(layout.lives).toEqual({ x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET });
  expect(layout.score).toEqual({ x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET });
  expect(layout.killMessageY).toBe(12);
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

test('phone portrait raises the radar above the fire button', () => {
  const layout = computeHudLayout(
    { width: 390, height: 844 },
    { touchControls: true, safeArea: ZERO }
  );
  expect(layout.lives.x).toBeGreaterThanOrEqual(12);
  expect(layout.lives.y).toBeGreaterThanOrEqual(12);
  expect(layout.miniMap.x + layout.miniMap.size).toBeLessThanOrEqual(390 - 12);
  expect(layout.miniMap.y + layout.miniMap.size).toBeLessThanOrEqual(844 - 12 - 112);
  expect(layout.leaderboard.maxRows).toBeLessThanOrEqual(6);
});

test('phone landscape parks the radar under lives so it misses the stick', () => {
  const layout = computeHudLayout(
    { width: 844, height: 390 },
    { touchControls: true, safeArea: ZERO }
  );
  expect(layout.miniMap.y).toBeGreaterThan(layout.score.y + 28);
  expect(layout.miniMap.x).toBe(layout.lives.x);
  expect(layout.leaderboard.maxRows).toBe(4);
});

test('safe-area insets push lives off the notch', () => {
  const layout = computeHudLayout(
    { width: 390, height: 844 },
    { touchControls: true, safeArea: { top: 47, right: 0, bottom: 34, left: 0 } }
  );
  expect(layout.lives.y).toBeGreaterThanOrEqual(47);
  expect(layout.padBottom).toBeGreaterThanOrEqual(34);
});
