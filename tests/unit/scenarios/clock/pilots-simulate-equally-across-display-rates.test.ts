import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkBoundaryCollision } from '../../../../shared/boundary';
import { SHIP } from '../../../../shared/constants/gameplay';
import { GAME_TICK_MS, MAX_CATCH_UP_TICKS } from '../../../../shared/gameClock';
import { WORLD } from '../../../../shared/world';
import { GameController } from '../../../../src/core/gameController';
import { Laser } from '../../../../src/entities/laser/Laser';
import { PlayerManager } from '../../../../src/entities/player/PlayerManager';
import { Roid } from '../../../../src/entities/roid/Roid';
import { canvasManager } from '../../../../src/rendering/canvasSurface';
import { asteroidRow } from '../../../support/asteroid-row';

const game = GameController.getInstance();

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
});

afterEach(() => {
  game.getCurrRoidBelt().roids.length = 0;
  canvasManager.destroy();
  vi.restoreAllMocks();
});

function arrangeFlight() {
  game.newGame('Clock pilot', 'scout');
  const ship = game.getCurrPlayer()?.ship;
  assert.ok(ship);
  ship.position = { x: 0, y: 0 };
  ship.velocity = { x: 1, y: 0 };
  ship.angle = 0;
  ship.angularVelocity = 0.005;
  ship.thrusting = true;
  ship.lasers = [new Laser({ x: 500, y: 500 }, { x: 2, y: 0 }, 0, 0)];
  const asteroid = new Roid(asteroidRow({ x: -500, y: -500 }, 20, 'clock-asteroid'));
  asteroid.velocity = { x: 0.2, y: -0.1 };
  game.getCurrRoidBelt().roids = [asteroid];
  return ship;
}

function flightSnapshot() {
  const ship = game.getCurrPlayer()?.ship;
  assert.ok(ship);
  return {
    position: { ...ship.position },
    velocity: { ...ship.velocity },
    angle: ship.angle,
    lasers: ship.lasers.map((laser) => ({ ...laser.position, distance: laser.distTraveled })),
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
    expect(reference.lasers).toEqual([{ x: 620, y: 500, distance: 120 }]);

    const ship = arrangeFlight();
    const steps = vi.spyOn(ship, 'update');
    for (let frame = 0; frame < hz; frame++) {
      game.updateGame(1000 / hz);
    }
    expect(flightSnapshot()).toEqual(reference);
    expect(steps).toHaveBeenCalledTimes(60);
  }
);

test('a wall contact inside a catch-up burst still reports its overlapping pose', () => {
  const ship = arrangeFlight();
  // Positioned so the FIRST of the burst's two frames is the one that touches
  // the wall: `floor(59985) + 15` clears it, `floor(59986.4) + 15` does not.
  // That makes this an intermediate frame, which no pose timer can observe.
  ship.position = { x: WORLD.radius - ship.r, y: 0 };
  ship.velocity = { x: SHIP.MAX_VELOCITY, y: 0 };
  ship.angle = 0;
  ship.angularVelocity = 0;
  ship.thrusting = true;
  ship.blinkCount = 0;
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(false);
  const reportedAt: Array<{ x: number; y: number }> = [];
  vi.spyOn(PlayerManager.getInstance(), 'updateNetworkState').mockImplementation(() => {
    reportedAt.push({ ...ship.position });
  });

  // A 30 Hz repaint drains two simulation frames in one synchronous loop, so the
  // 60 Hz pose timer can only ever observe the second of them. The contact has
  // to be reported from inside the frame that detects it, or a contact lasting
  // one frame never reaches the server and the wall is not lethal here.
  game.updateGame(1000 / 30);

  expect(reportedAt).toHaveLength(1);
  const carried = reportedAt[0];
  assert.ok(carried);
  expect(checkBoundaryCollision(carried, ship.r)).toBe(true);
  // Captured before the burst finished: the hull has travelled further by the
  // time the loop returns, so a pose sampled at the burst's end would carry a
  // different, later position than this one.
  expect(carried.x).toBeLessThan(ship.position.x);

  // And only on the rising edge: a hull grinding along the wall must not add a
  // second pose every frame, which would spend the inbound message budget that
  // `server/communication/messageBudget.ts` reserves for commands.
  const afterFirstContact = reportedAt.length;
  game.updateGame(1000 / 30);
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(true);
  expect(reportedAt).toHaveLength(afterFirstContact);
});

test('a resumed or sub-tick frame does not advance motion or projectiles', () => {
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
  { step: 'first', rockX: -50 },
  { step: 'second', rockX: 50 },
])('catch-up advances a shot across a rock during the $step simulated step', ({ rockX }) => {
  const ship = arrangeFlight();
  ship.position = { x: -1000, y: -1000 };
  ship.thrusting = false;
  const laser = new Laser({ x: -100, y: 0 }, { x: 100, y: 0 }, 0, 0);
  ship.lasers = [laser];
  const asteroid = new Roid(asteroidRow({ x: rockX, y: 0 }, 10, 'crossed-rock'));
  asteroid.velocity = { x: 0, y: 0 };
  game.getCurrRoidBelt().roids = [asteroid];

  game.updateGame(GAME_TICK_MS * 2);

  // The current multiplayer protocol leaves asteroid impact resolution to the
  // server. The client still advances visual projectiles on the same fixed
  // clock, but crossing a local rock does not destroy it optimistically.
  expect(laser.hasExploded).toBe(false);
  expect(laser.position).toEqual({ x: 100, y: 0 });
  expect(laser.distTraveled).toBe(200);
  expect(game.getCurrRoidBelt().getRoids()).toContain(asteroid);
});
