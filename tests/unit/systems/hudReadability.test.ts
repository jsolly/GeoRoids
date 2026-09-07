import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

import { PALETTE, SHIP, TITLE, VISUAL } from '../../../src/constants';
import { layoutHudCluster } from '../../../src/rendering/hud/cluster';
import { projectWorldToMiniMap } from '../../../src/rendering/hud/minimap';

const livesSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/lives.ts'), 'utf8');
const scoreSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/gameInfo.ts'), 'utf8');
const radarSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/minimap.ts'), 'utf8');
const clusterSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/cluster.ts'), 'utf8');

test('locked palette hexes stay the #415/#435 playfield swatch', () => {
  expect(PALETTE).toEqual({
    BG: '#000011',
    STARS: '#8BA3C7',
    LOCAL: '#5EEAD4',
    REMOTE: '#7DD3FC',
    BOT: '#FB923C',
    ROID: '#94A3B8',
    CONTOUR: '#5A6B7D',
    LASER_LOCAL: '#FDE68A',
    LASER_ENEMY: '#FCA5A5',
    HUD: '#E2E8F0',
    HUD_MUTED: '#64748B',
    DANGER: '#F43F5E',
    HEALTH: '#4ADE80',
    LOOT: '#E8D5A3',
    SHIELD: '#7DD3C8',
    SATELLITE: '#C4B5FD',
    SATELLITE_PICKUP: '#FBBF24',
  });
  expect(TITLE.ACCENT).toBe('#A78BFA');
  expect(PALETTE).not.toHaveProperty('ACCENT_UI');
});

test('lives glyphs stay tiny phosphor hulls, not full SHIP.SIZE', () => {
  expect(VISUAL.HUD_LIFE_SIZE).toBe(14);
  expect(VISUAL.HUD_LIFE_SIZE).toBeLessThan(SHIP.SIZE / 2);
  expect(VISUAL.HUD_INSET).toBe(16);
  expect(livesSrc).toMatch(/layoutHudCluster/);
  expect(livesSrc).toMatch(/strokeKitHullOutline/);
  expect(livesSrc).toMatch(/HUD_LIFE_HEADING/);
  expect(livesSrc).not.toMatch(/SHIP\.SIZE/);
});

test('score sits in the same cluster in HUD cream', () => {
  expect(VISUAL.SCORE_FONT).toBe('14px Arial');
  expect(scoreSrc).toMatch(/layoutHudCluster\(lives\)/);
  expect(scoreSrc).toMatch(/PALETTE\.HUD/);
  expect(scoreSrc).toMatch(/FACTION_LABELS\[faction\]/);
  expect(scoreSrc).toMatch(/drawFuelGauge/);
  expect(scoreSrc).not.toMatch(/SHIP\.SIZE/);
  expect(scoreSrc).not.toMatch(/#fff|#ffffff/i);
});

test('layoutHudCluster keeps three lives and the score in one compact strip', () => {
  const three = layoutHudCluster(3);
  expect(three.lifeCenters).toHaveLength(3);
  expect(three.lifeCenters[0]).toEqual({
    x: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
    y: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
  });
  const last = three.lifeCenters[2];
  const first = three.lifeCenters[0];
  expect(first).toBeDefined();
  expect(last).toBeDefined();
  if (!first || !last) {
    throw new Error('expected three life centers');
  }
  expect(three.score.x).toBeGreaterThan(last.x + VISUAL.HUD_LIFE_SIZE / 2);
  expect(three.score.x).toBeLessThan(120);
  expect(three.score.y).toBe(first.y);

  const none = layoutHudCluster(0);
  expect(none.lifeCenters).toEqual([]);
  expect(none.score).toEqual({
    x: VISUAL.HUD_INSET,
    y: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
  });
});

test('radar uses a whisper void, a brighter ring, and a local heading mark', () => {
  expect(VISUAL.MINIMAP_SIZE).toBe(96);
  expect(VISUAL.MINIMAP_VOID_ALPHA).toBeLessThanOrEqual(0.5);
  expect(VISUAL.MINIMAP_VOID_ALPHA).toBeGreaterThan(0);
  expect(VISUAL.MINIMAP_RING_ALPHA).toBeGreaterThan(0.5);
  expect(VISUAL.MINIMAP_DOT).toBeGreaterThanOrEqual(4);
  expect(VISUAL.MINIMAP_LOCAL_SIZE).toBeGreaterThan(VISUAL.MINIMAP_DOT / 2);
  expect(radarSrc).toMatch(/strokePhosphorHull/);
  expect(radarSrc).toMatch(/kind: 'local'/);
  expect(radarSrc).toMatch(/MINIMAP_VOID_ALPHA/);
  expect(radarSrc).toMatch(/drawSoftFactionMark/);
  expect(radarSrc).toMatch(/getShipDisplayColor/);
  expect(radarSrc).toMatch(/isAsteroidPending/);
  expect(radarSrc).toMatch(/canDrawAsteroid/);
  expect(radarSrc).not.toMatch(/Game Server/i);
  expect(radarSrc).not.toMatch(/drawServerInfo/);
  for (const src of [livesSrc, scoreSrc, radarSrc, clusterSrc]) {
    expect(src).not.toMatch(/ACCENT_UI|TITLE\.ACCENT/);
  }
});

test('projectWorldToMiniMap maps the arena center to the radar center', () => {
  const boundary = { cx: 0, cy: 0, radius: 100 };
  const center = projectWorldToMiniMap(boundary, 0, 0, 80, 0, 0);
  expect(center).toEqual({ x: 40, y: 40 });

  const east = projectWorldToMiniMap(boundary, 0, 0, 80, 100, 0);
  expect(east).toEqual({ x: 80, y: 40 });
  expect(east).not.toBe(center);
  expect(center).toEqual({ x: 40, y: 40 });

  const outside = projectWorldToMiniMap(boundary, 0, 0, 80, 400, 0, 10);
  expect(outside).toBeNull();
});
