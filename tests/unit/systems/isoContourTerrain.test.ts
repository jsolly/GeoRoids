import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyShipMotionFrame } from '../../../server/ai/shipMotion';
import { GameEngine } from '../../../server/core/GameEngine';
import { stepReleasedMotion } from '../../../shared/asteroidMotion';
import { GAME, PALETTE, VISUAL } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { applyVelocity } from '../../../src/entities/ship/ShipMovementManager';
import { contourSegmentCount, extractIsoContours } from '../../../src/physics/terrain/contours';
import {
  createHeightfield,
  sampleGradient,
  sampleHeight,
} from '../../../src/physics/terrain/heightfield';
import { applySlopeForce } from '../../../src/physics/terrain/slopeForce';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import {
  applyTerrainSeed,
  ensureTerrain,
  getTerrainSeed,
} from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvas';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';

const BOUNDS = { cx: 0, cy: 0, radius: 3100 };

afterEach(() => {
  vi.restoreAllMocks();
});

function steepestSample(seed: number): { x: number; y: number; steep: number } {
  const field = createHeightfield(seed, BOUNDS);
  const x = BOUNDS.radius / 2;
  const gradient = sampleGradient(field, x, 0);
  return { x, y: 0, steep: Math.hypot(gradient.x, gradient.y) };
}

describe('seeded heightfield is shared', () => {
  test('the same seed produces the same heights and contour set', () => {
    const a = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const b = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const samples = [
      { x: 0, y: 0 },
      { x: 400, y: -200 },
      { x: -1200, y: 800 },
      { x: 2000, y: 1400 },
    ];
    for (const p of samples) {
      expect(sampleHeight(a, p.x, p.y)).toBe(sampleHeight(b, p.x, p.y));
    }
    expect(extractIsoContours(a)).toEqual(extractIsoContours(b));
  });

  test('room seeds produce distinct hills and valleys', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const other = createHeightfield(TERRAIN.DEFAULT_SEED + 99, BOUNDS);
    expect(sampleHeight(field, 1550, 0)).not.toBe(sampleHeight(other, 1550, 0));
    expect(sampleHeight(field, 1550, 0)).toBeGreaterThan(0);
    expect(sampleHeight(field, 500, 500)).toBeLessThan(0);
    expect(sampleHeight(field, 1550, 0)).not.toBe(sampleHeight(field, 0, 1550));
  });

  test('gameState carries the room seed so late joiners match', () => {
    const engine = new GameEngine(1);
    const state = engine.getGameState();
    expect(state.terrainSeed).toBe(TERRAIN.DEFAULT_SEED);
    expect(engine.getTerrainSeed()).toBe(getTerrainSeed());
    applyTerrainSeed(state.terrainSeed);
    expect(getTerrainSeed()).toBe(TERRAIN.DEFAULT_SEED);
    engine.stopGameLoop();
  });
});

describe('iso contours encode elevation', () => {
  test('tight contour spacing lines up with a steep gradient', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const levels = extractIsoContours(field);
    expect(contourSegmentCount(levels)).toBeGreaterThan(200);

    const cell = 280;
    const buckets: Array<{ steep: number; segments: number; count: number }> = [];
    for (let x = -1800; x <= 1800; x += cell) {
      for (let y = -1800; y <= 1800; y += cell) {
        if (x * x + y * y > BOUNDS.radius * BOUNDS.radius) {
          continue;
        }
        const steep = Math.hypot(sampleGradient(field, x, y).x, sampleGradient(field, x, y).y);
        let segments = 0;
        for (const level of levels) {
          for (const seg of level.segments) {
            const mx = (seg.ax + seg.bx) * 0.5;
            const my = (seg.ay + seg.by) * 0.5;
            if (Math.abs(mx - x) <= cell / 2 && Math.abs(my - y) <= cell / 2) {
              segments++;
            }
          }
        }
        buckets.push({ steep, segments, count: 1 });
      }
    }

    expect(buckets.length).toBeGreaterThan(20);
    const ranked = [...buckets].sort((a, b) => a.steep - b.steep);
    const quartile = Math.max(1, Math.floor(ranked.length / 4));
    const flatish = ranked.slice(0, quartile);
    const steepish = ranked.slice(-quartile);
    const avgSteep = steepish.reduce((sum, b) => sum + b.segments, 0) / steepish.length;
    const avgFlat = flatish.reduce((sum, b) => sum + b.segments, 0) / flatish.length;
    expect(avgSteep).toBeGreaterThan(avgFlat);
  });

  test('contours stay inside the circular arena', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    for (const level of extractIsoContours(field)) {
      for (const seg of level.segments) {
        const mx = (seg.ax + seg.bx) * 0.5;
        const my = (seg.ay + seg.by) * 0.5;
        expect(Math.hypot(mx, my)).toBeLessThanOrEqual(BOUNDS.radius + 1);
      }
    }
  });
});

describe('ships feel the slope', () => {
  test('a coasting ship accelerates downhill and slows uphill', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const peak = steepestSample(TERRAIN.DEFAULT_SEED);
    expect(peak.steep).toBeGreaterThan(0.0004);

    const g = sampleGradient(field, peak.x, peak.y);
    const len = Math.hypot(g.x, g.y);
    const nx = g.x / len;
    const ny = g.y / len;

    const downhill = { x: 0, y: 0 };
    applySlopeForce(downhill, { x: peak.x, y: peak.y }, field, 1);
    const downDot = downhill.x * -nx + downhill.y * -ny;
    expect(downDot).toBeGreaterThan(0);

    const uphill = { x: nx * 2, y: ny * 2 };
    const before = Math.hypot(uphill.x, uphill.y);
    applySlopeForce(uphill, { x: peak.x, y: peak.y }, field, 1);
    expect(Math.hypot(uphill.x, uphill.y)).toBeLessThan(before);
  });

  test('the flat spawn has no preferred downhill direction so parked ships do not slide', () => {
    const field = createHeightfield(TERRAIN.DEFAULT_SEED, BOUNDS);
    const g = sampleGradient(field, 0, 0);
    expect(Math.hypot(g.x, g.y)).toBeLessThan(1e-5);
    const velocity = { x: 1, y: 1 };
    applySlopeForce(velocity, { x: 0, y: 0 }, field);
    expect(velocity.x).toBeCloseTo(1, 6);
    expect(velocity.y).toBeCloseTo(1, 6);
  });

  test('player and bot movement both apply the shared slope helper', () => {
    const peak = steepestSample(TERRAIN.DEFAULT_SEED);
    ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
    const player = {
      position: { x: peak.x, y: peak.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      angularVelocity: 0,
      thrusting: false,
      thrusterActive: false,
      frictionCoefficient: GAME.FRICTION,
    };
    const bot = {
      position: { x: peak.x, y: peak.y },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
    };

    applyVelocity(player);
    applyShipMotionFrame(bot);

    expect(bot.velocity.x).toBeCloseTo(player.velocity.x, 10);
    expect(bot.velocity.y).toBeCloseTo(player.velocity.y, 10);
    expect(Math.hypot(player.velocity.x, player.velocity.y)).toBeGreaterThan(0);
  });
});

describe('muted contour chrome', () => {
  test('contour strokes stay darker and thinner than ships and lasers', () => {
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe('#ffffff');
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe(PALETTE.LOCAL.toLowerCase());
    expect(PALETTE.CONTOUR.toLowerCase()).not.toBe(PALETTE.LASER_LOCAL.toLowerCase());
    expect(VISUAL.CONTOUR_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.SHIP_STROKE_WIDTH);
    expect(VISUAL.CONTOUR_ALPHA).toBeLessThanOrEqual(0.3);
    expect(VISUAL.CONTOUR_INDEX_ALPHA).toBeLessThanOrEqual(0.5);
    expect(VISUAL.CONTOUR_INDEX_ALPHA).toBeGreaterThan(VISUAL.CONTOUR_ALPHA);
  });

  test('terrain elevations stay on their contours while the camera moves', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Missing real terrain canvas');
    }
    vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
    vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
    vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
    ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
    const rendered: Array<{ text: string; x: number; y: number }> = [];
    const fillText = ctx.fillText.bind(ctx);
    vi.spyOn(ctx, 'fillText').mockImplementation((text, x, y) => {
      const transform = ctx.getTransform();
      rendered.push({ text, x: transform.e, y: transform.f });
      fillText(text, x, y);
    });
    drawIsoContours({ x: 0, y: 0 });
    const before = rendered.splice(0);
    expect(before.length).toBeGreaterThan(2);
    for (const label of before) {
      expect(label.text).toMatch(/^-?\d+\.\d{2}$/);
      expect(label.x).toBeGreaterThan(0);
      expect(label.x).toBeLessThan(canvas.width);
      expect(label.y).toBeGreaterThan(0);
      expect(label.y).toBeLessThan(canvas.height);
    }
    drawIsoContours({ x: 50, y: 0 });
    const retained = before.filter((label) => label.x > 100 && label.x < 700);
    expect(retained.length).toBeGreaterThan(0);
    for (const label of retained) {
      const moved = rendered.find(
        (candidate) => candidate.text === label.text && Math.abs(candidate.y - label.y) < 0.001
      );
      expect(moved).toBeDefined();
      expect(moved?.x).toBeCloseTo(label.x - 50, 5);
    }
  });
});

test('ensureTerrain caches the active room field', () => {
  const first = ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  const second = ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  expect(second).toBe(first);
});

test('translated arenas retain the same terrain and a stable flat spawn', () => {
  const base = createHeightfield(7, BOUNDS);
  const field = createHeightfield(7, { cx: 250, cy: -170, radius: 3100 });
  for (const { x, y } of [
    { x: 0, y: 0 },
    { x: 500, y: 500 },
    { x: 1550, y: 0 },
    { x: -600, y: 800 },
  ]) {
    expect(sampleHeight(field, field.cx + x, field.cy + y)).toBeCloseTo(
      sampleHeight(base, x, y),
      10
    );
  }
  expect(sampleHeight(field, field.cx + field.radius + 10, field.cy)).toBe(0);
  expect(sampleGradient(field, field.cx + field.radius, field.cy)).toEqual({ x: 0, y: 0 });
  const inside = sampleGradient(field, field.cx + field.radius - 1, field.cy);
  expect(Math.hypot(inside.x, inside.y)).toBeLessThan(1e-5);
});

test.each([
  1, 8,
])('a mass-%s pilot travels farther downhill but can still thrust uphill', (mass) => {
  ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  const startX = BOUNDS.radius / 2;
  const downhill = new Ship({ position: { x: startX, y: 0 } });
  const uphill = new Ship({ position: { x: startX, y: 0 } });
  for (const ship of [downhill, uphill]) {
    ship.mass = mass;
    ship.thrusting = true;
    ship.velocity = { x: 0, y: 0 };
  }
  downhill.angle = Math.PI;
  uphill.angle = 0;
  const bot = {
    position: { x: startX, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: Math.PI,
    thrusting: true,
    mass,
  };
  for (let frame = 0; frame < 120; frame++) {
    downhill.move();
    uphill.move();
    applyShipMotionFrame(bot);
    // Compare acceleration before either ship reaches its speed cap or crosses a new slope.
    if (frame === 14) {
      expect(Math.hypot(downhill.velocity.x, downhill.velocity.y)).toBeGreaterThan(
        Math.hypot(uphill.velocity.x, uphill.velocity.y)
      );
    }
  }
  const downDistance = startX - downhill.position.x;
  const upDistance = uphill.position.x - startX;
  expect(upDistance).toBeGreaterThan(50);
  expect(downDistance).toBeGreaterThan(upDistance * 1.05);
  expect(bot.position.x).toBeCloseTo(downhill.position.x, 8);
  expect(bot.velocity.x).toBeCloseTo(downhill.velocity.x, 8);
});

test('a ship released from an asteroid also travels faster downhill than uphill', () => {
  ensureTerrain(TERRAIN.DEFAULT_SEED, BOUNDS);
  const downhill = { position: { x: 1550, y: 0 }, velocity: { x: -12, y: 0 }, angle: Math.PI };
  const uphill = { position: { x: 1550, y: 0 }, velocity: { x: 12, y: 0 }, angle: 0 };
  for (let frame = 0; frame < 30; frame++) {
    stepReleasedMotion(downhill, { thrust: false, turn: 0, aimAngle: 0 }, 5 / GAME.FPS, 450, 1);
    stepReleasedMotion(uphill, { thrust: false, turn: 0, aimAngle: 0 }, 5 / GAME.FPS, 450, 1);
  }
  expect(1550 - downhill.position.x).toBeGreaterThan(uphill.position.x - 1550);
  expect(-downhill.velocity.x).toBeGreaterThan(uphill.velocity.x);
  expect(uphill.velocity.x).toBeGreaterThan(0);
});
