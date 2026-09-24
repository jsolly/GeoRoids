import { expect, test } from 'vitest';
import { UNIVERSE_MAP_ZOOM } from '../../../src/ui/universeMap';
import { FURNACE_NAME_ZOOM, mapAssetNameVisible } from '../../../src/ui/universeMapLabels';

test('furnace names stay hidden until the universe map is zoomed in close', () => {
  const nearby = UNIVERSE_MAP_ZOOM.initial;
  const oneStepCloser = nearby * UNIVERSE_MAP_ZOOM.step;
  expect(FURNACE_NAME_ZOOM).toBe(32);
  expect(FURNACE_NAME_ZOOM).toBeGreaterThan(nearby);
  expect(oneStepCloser).toBeGreaterThanOrEqual(FURNACE_NAME_ZOOM);

  for (const kind of ['furnace', 'foundation'] as const) {
    expect(mapAssetNameVisible(kind, UNIVERSE_MAP_ZOOM.min, 0)).toBe(false);
    expect(mapAssetNameVisible(kind, nearby, 0)).toBe(false);
    expect(mapAssetNameVisible(kind, 7.23, 0)).toBe(false);
    expect(mapAssetNameVisible(kind, FURNACE_NAME_ZOOM - 0.01, 0)).toBe(false);
    expect(mapAssetNameVisible(kind, FURNACE_NAME_ZOOM, 0)).toBe(true);
    expect(mapAssetNameVisible(kind, oneStepCloser, 0)).toBe(true);
    expect(mapAssetNameVisible(kind, UNIVERSE_MAP_ZOOM.max, 20)).toBe(true);
  }

  expect(mapAssetNameVisible('wreckage', UNIVERSE_MAP_ZOOM.min, 0)).toBe(true);
  expect(mapAssetNameVisible('wreckage', UNIVERSE_MAP_ZOOM.min, 1)).toBe(false);
  expect(mapAssetNameVisible('satellite', 2.8, 4)).toBe(true);
  expect(mapAssetNameVisible('satellite', 2.79, 1)).toBe(false);
});
