import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

import { PALETTE, ROID, VISUAL } from '../../../src/constants';
import { shouldDrawRoidInnerFacet } from '../../../src/entities/roid/roidRenderer';
import {
  ASTEROID_PENDING_MS,
  lockAsteroidPending,
  pendingElapsedMs,
} from '../../../src/physics/collision/asteroidHitFeel';
import {
  burstTick,
  easeOutCubic,
  laserBoltOffsets,
  polygonPoints,
  thrusterFlameGeometry,
} from '../../../src/rendering/vectorJuice';

const shipSrc = readFileSync(resolve(process.cwd(), 'src/entities/ship/shipRenderer.ts'), 'utf8');
const roidSrc = readFileSync(resolve(process.cwd(), 'src/entities/roid/roidRenderer.ts'), 'utf8');
const laserSrc = readFileSync(
  resolve(process.cwd(), 'src/entities/laser/laserRenderer.ts'),
  'utf8'
);

test('large roids get an inner Asteroids facet; medium and pebbles stay one outline', () => {
  expect(shouldDrawRoidInnerFacet(ROID.SIZE)).toBe(true);
  expect(shouldDrawRoidInnerFacet(ROID.SIZE * 0.5)).toBe(false);
  expect(shouldDrawRoidInnerFacet(ROID.SIZE * 0.2)).toBe(false);
  expect(VISUAL.ROID_INNER_SCALE).toBeGreaterThan(0.3);
  expect(VISUAL.ROID_INNER_SCALE).toBeLessThan(0.7);
});

test('roid outline points stay a closed jagged silhouette, not a circle fill', () => {
  const offsets = [1.1, 0.8, 1.05, 0.9, 1.2, 0.85];
  const outer = polygonPoints(0, 0, 40, 0, offsets.length, offsets);
  const inner = polygonPoints(0, 0, 40, 0, offsets.length, offsets, VISUAL.ROID_INNER_SCALE);
  expect(outer).toHaveLength(6);
  expect(inner).toHaveLength(6);
  const outerReach = Math.hypot(outer[0]?.x ?? 0, outer[0]?.y ?? 0);
  const innerReach = Math.hypot(inner[0]?.x ?? 0, inner[0]?.y ?? 0);
  expect(innerReach).toBeCloseTo(outerReach * VISUAL.ROID_INNER_SCALE);
  expect(roidSrc).toMatch(/strokePhosphorPolyline/);
  expect(roidSrc).toMatch(/shouldDrawRoidInnerFacet/);
  expect(roidSrc).toMatch(/drawRoidShatter/);
});

test('roid shatter occupies only the first slice of the pending lock', () => {
  const roid = { pendingDestruction: false, pendingUntilMs: 0 };
  lockAsteroidPending(roid, 1_000);
  expect(pendingElapsedMs(roid, 1_000)).toBe(0);
  expect(pendingElapsedMs(roid, 1_000 + VISUAL.ROID_SHATTER_MS - 1)).toBe(
    VISUAL.ROID_SHATTER_MS - 1
  );
  expect(VISUAL.ROID_SHATTER_MS).toBeLessThan(ASTEROID_PENDING_MS);
  expect(pendingElapsedMs({ pendingDestruction: false, pendingUntilMs: 0 }, 1_000)).toBeNull();
});

test('laser juice is a short dash plus a shorter heading ghost', () => {
  const { halfX, halfY, trailX } = laserBoltOffsets(
    10,
    0,
    VISUAL.LASER_LENGTH / 2,
    VISUAL.LASER_TRAIL_LENGTH
  );
  expect(halfX).toBeCloseTo(VISUAL.LASER_LENGTH / 2);
  expect(halfY).toBe(0);
  expect(trailX).toBeCloseTo(VISUAL.LASER_TRAIL_LENGTH);
  expect(Math.hypot(halfX * 2, halfY * 2)).toBeLessThan(20);
  expect(shipSrc).toMatch(/LASER_TRAIL_LENGTH/);
  expect(shipSrc).toMatch(/LASER_HIT_TICKS/);
});

test('thruster juice keeps one shared V with a shorter inner core', () => {
  const flame = thrusterFlameGeometry(
    0,
    0,
    0,
    30,
    VISUAL.THRUSTER_LENGTH_RATIO,
    VISUAL.THRUSTER_CORE_RATIO
  );
  const outer = Math.hypot(flame.tip.x - flame.rear.x, flame.tip.y - flame.rear.y);
  const inner = Math.hypot(flame.coreTip.x - flame.rear.x, flame.coreTip.y - flame.rear.y);
  expect(inner).toBeLessThan(outer);
  expect(inner).toBeCloseTo(outer * VISUAL.THRUSTER_CORE_RATIO);
  expect(shipSrc).toMatch(/thrusterFlameGeometry/);
  expect(shipSrc).toMatch(/drawGenericThruster/);
  expect(shipSrc).not.toMatch(/drawBotThruster|drawLocalThruster/);
});

test('death and hit bursts pop then coast, with ticks instead of white fills', () => {
  expect(easeOutCubic(0)).toBe(0);
  expect(easeOutCubic(1)).toBe(1);
  expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  const tick = burstTick(0, 0, 0, 4, 10);
  expect(tick.x2 - tick.x1).toBeCloseTo(6);
  expect(VISUAL.EXPLOSION_SPARKS).toBeGreaterThanOrEqual(8);
  expect(VISUAL.EXPLOSION_HIT_TICKS).toBe(4);
  expect(VISUAL.EXPLOSION_RING_RATIO).toBeGreaterThan(1.5);
  expect(shipSrc).toMatch(/strokeBurstTicks/);
  expect(shipSrc).toMatch(/easeOutCubic/);
});

test('locked palette stays on ships, lasers, and roids — no white, no accent on the playfield', () => {
  expect(PALETTE.ROID).toBe('#94A3B8');
  expect(PALETTE.LASER_LOCAL).toBe('#FDE68A');
  expect(PALETTE.LASER_ENEMY).toBe('#FCA5A5');
  expect(PALETTE.DANGER).toBe('#F43F5E');
  expect(roidSrc).toMatch(/PALETTE\.ROID/);
  expect(roidSrc).not.toMatch(/PALETTE\.ACCENT_UI/);
  expect(laserSrc).toMatch(/PALETTE\.LASER_LOCAL/);
  expect(laserSrc).not.toMatch(/#fff|#ffffff|#00ffff/i);
  expect(shipSrc).not.toMatch(/#fff|#ffffff/i);
});
