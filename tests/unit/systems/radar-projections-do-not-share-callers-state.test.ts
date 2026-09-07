import { expect, test } from 'vitest';
import { projectWorldToMiniMapInto } from '../../../src/rendering/hud/minimap';

test('two radar renderers keep independent projection buffers while reusing their own', () => {
  const boundary = { cx: 0, cy: 0, radius: 100 };
  const firstRenderer = { x: 0, y: 0 };
  const secondRenderer = { x: 0, y: 0 };
  expect(projectWorldToMiniMapInto(firstRenderer, boundary, 0, 0, 80, 0, 0)).toBe(firstRenderer);
  projectWorldToMiniMapInto(secondRenderer, boundary, 0, 0, 80, 100, 0);
  expect(firstRenderer).toEqual({ x: 40, y: 40 });
  expect(secondRenderer).toEqual({ x: 80, y: 40 });
  expect(projectWorldToMiniMapInto(firstRenderer, boundary, 0, 0, 80, -100, 0)).toBe(firstRenderer);
  expect(firstRenderer).toEqual({ x: 0, y: 40 });
  expect(secondRenderer).toEqual({ x: 80, y: 40 });
  expect(projectWorldToMiniMapInto(firstRenderer, boundary, 0, 0, 80, 400, 0)).toBeNull();
  expect(firstRenderer).toEqual({ x: 0, y: 40 });
});
