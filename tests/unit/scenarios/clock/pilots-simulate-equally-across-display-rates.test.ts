import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GAME_TICK_MS, MAX_CATCH_UP_TICKS } from '../../../../shared/gameClock';
import { GameController } from '../../../../src/core/gameController';
import { Laser } from '../../../../src/entities/laser/Laser';
import { Roid } from '../../../../src/entities/roid/Roid';
import { SatelliteManager } from '../../../../src/entities/satellite/SatelliteManager';
import { canvasManager } from '../../../../src/rendering/canvas';

const game = GameController.getInstance();
const satellites = SatelliteManager.getInstance();

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  canvasManager.initialize();
});

afterEach(() => {
  satellites.clear();
  game.getCurrRoidBelt().roids.length = 0;
  canvasManager.destroy();
  vi.restoreAllMocks();
});

function arrangeFlight() {
  game.newGame('Clock pilot', 'dart');
  const ship = game.getCurrPlayer()?.ship;
  assert.ok(ship);
  ship.position = { x: 0, y: 0 };
  ship.velocity = { x: 1, y: 0 };
  ship.angle = 0;
  ship.angularVelocity = 0.005;
  ship.thrusting = true;
  ship.shieldCooldown = 240;
  ship.lasers = [new Laser({ x: 500, y: 500 }, { x: 2, y: 0 }, 0, 0)];
  const asteroid = new Roid({ x: -500, y: -500 }, 20, 'clock-asteroid');
  asteroid.velocity = { x: 0.2, y: -0.1 };
  game.getCurrRoidBelt().roids = [asteroid];
  satellites.clear();
  satellites.syncFromServer([
    {
      id: 'clock-satellite',
      name: 'Landsat 7',
      typeId: 'landsat-7',
      assetKey: 'eo/landsat-7',
      shotManner: 'steady-optical-ping',
      position: { x: 1000, y: -1000 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      exploding: false,
      color: '#C4B5FD',
      health: 50,
      maxHealth: 50,
      radius: 16,
    },
  ]);
  satellites.addLaser('clock-satellite', 'clock-shot', { x: 900, y: -900 }, { x: 1, y: 0 });
  return ship;
}

function flightSnapshot() {
  const ship = game.getCurrPlayer()?.ship;
  assert.ok(ship);
  return {
    position: { ...ship.position },
    velocity: { ...ship.velocity },
    angle: ship.angle,
    shieldCooldown: ship.shieldCooldown,
    lasers: ship.lasers.map((laser) => ({ ...laser.position, distance: laser.distTraveled })),
    satelliteLasers: satellites.get('clock-satellite')?.lasers.map((laser) => ({
      ...laser.position,
      distance: laser.distTraveled,
    })),
    asteroids: game.getCurrRoidBelt().roids.map((asteroid) => ({ ...asteroid.position })),
  };
}

test.each([30, 60, 120, 144])(
  'a pilot at %i Hz flies and ages shots like the 60 Hz reference',
  (hz) => {
    arrangeFlight();
    for (let frame = 0; frame < 60; frame++) {
      game.updateGame(GAME_TICK_MS);
    }
    const reference = flightSnapshot();
    expect(reference.shieldCooldown).toBe(180);
    expect(reference.lasers).toEqual([{ x: 620, y: 500, distance: 120 }]);
    expect(reference.satelliteLasers).toEqual([{ x: 960, y: -900, distance: 60 }]);

    const ship = arrangeFlight();
    const steps = vi.spyOn(ship, 'update');
    for (let frame = 0; frame < hz; frame++) {
      game.updateGame(1000 / hz);
    }
    expect(flightSnapshot()).toEqual(reference);
    expect(steps).toHaveBeenCalledTimes(60);
  }
);

test('a resumed or sub-tick frame does not advance motion, shield time, or projectiles', () => {
  const ship = arrangeFlight();
  const steps = vi.spyOn(ship, 'update');
  const before = flightSnapshot();
  game.updateGame(0);
  game.updateGame(GAME_TICK_MS / 2);
  expect(flightSnapshot()).toEqual(before);
  expect(steps).not.toHaveBeenCalled();

  game.resetPresentationClock();
  game.updateGame(GAME_TICK_MS / 2);
  expect(flightSnapshot()).toEqual(before);
  game.updateGame(GAME_TICK_MS / 2);
  expect(steps).toHaveBeenCalledTimes(1);
  expect(flightSnapshot().shieldCooldown).toBe(239);
});

test('a long hitch simulates the bounded second once and discards older movement debt', () => {
  arrangeFlight();
  for (let frame = 0; frame < MAX_CATCH_UP_TICKS; frame++) {
    game.updateGame(GAME_TICK_MS);
  }
  const reference = flightSnapshot();
  const ship = arrangeFlight();
  const steps = vi.spyOn(ship, 'update');
  game.updateGame(60_000);
  expect(flightSnapshot()).toEqual(reference);
  expect(steps).toHaveBeenCalledTimes(MAX_CATCH_UP_TICKS);
  game.updateGame(0);
  expect(flightSnapshot()).toEqual(reference);
  expect(steps).toHaveBeenCalledTimes(MAX_CATCH_UP_TICKS);
});

test.each([
  { step: 'first', rockX: -50, impactX: 0 },
  { step: 'second', rockX: 50, impactX: 100 },
])(
  'catch-up checks a shot crossing a rock during the $step simulated step',
  ({ rockX, impactX }) => {
    const ship = arrangeFlight();
    ship.position = { x: -1000, y: -1000 };
    ship.thrusting = false;
    const laser = new Laser({ x: -100, y: 0 }, { x: 100, y: 0 }, 0, 0);
    ship.lasers = [laser];
    const asteroid = new Roid({ x: rockX, y: 0 }, 10, 'crossed-rock');
    asteroid.velocity = { x: 0, y: 0 };
    game.getCurrRoidBelt().roids = [asteroid];

    game.updateGame(GAME_TICK_MS * 2);

    expect(laser.hasExploded).toBe(true);
    expect(laser.position).toEqual({ x: impactX, y: 0 });
    expect(asteroid.pendingDestruction).toBe(true);
  }
);
