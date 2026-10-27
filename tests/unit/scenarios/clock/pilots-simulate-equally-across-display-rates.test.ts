import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GAMEPLAY_MESSAGE_BUDGET } from '../../../../server/communication/messageBudget';
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
  game.getCurrRoidBelt().replaceAll([]);
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
  game.getCurrRoidBelt().replaceAll([asteroid]);
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
    asteroids: game
      .getCurrRoidBelt()
      .getRoids()
      .map((asteroid) => ({ ...asteroid.position })),
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
  // Independent pins: the arrangement above depends on these three constants,
  // so a change to any of them must fail here rather than move both sides of
  // the geometry assertions at once.
  expect(ship.r).toBe(15);
  expect(WORLD.radius).toBe(60_000);
  expect(SHIP.MAX_VELOCITY).toBeGreaterThan(1);
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(false);
  const reportedAt: Array<{ x: number; y: number }> = [];
  vi.spyOn(PlayerManager.getInstance(), 'updateNetworkState').mockImplementation(() => {
    reportedAt.push({ ...ship.position });
    // The latch records delivery, so a report must look delivered here.
    return true;
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

  // Leaving contact has to re-arm the latch, or only the first wall contact of
  // a session is ever reported from its own frame and every later one falls
  // back on the pose timer that cannot see an intermediate burst frame.
  ship.position = { x: 0, y: 0 };
  game.updateGame(GAME_TICK_MS);
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(false);
  expect(reportedAt).toHaveLength(afterFirstContact);

  ship.position = { x: WORLD.radius - ship.r, y: 0 };
  ship.velocity = { x: SHIP.MAX_VELOCITY, y: 0 };
  ship.angle = 0;
  ship.angularVelocity = 0;
  game.updateGame(1000 / 30);

  expect(reportedAt).toHaveLength(afterFirstContact + 1);
  const second = reportedAt[afterFirstContact];
  assert.ok(second);
  expect(checkBoundaryCollision(second, ship.r)).toBe(true);
});

test('a wall contact report that never left is retried on the next frame', () => {
  const ship = arrangeFlight();
  ship.position = { x: WORLD.radius - ship.r + 1, y: 0 };
  ship.velocity = { x: SHIP.MAX_VELOCITY, y: 0 };
  ship.angle = 0;
  ship.angularVelocity = 0;
  ship.thrusting = true;
  ship.blinkCount = 0;
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(true);
  let delivered = false;
  const attempts: boolean[] = [];
  vi.spyOn(PlayerManager.getInstance(), 'updateNetworkState').mockImplementation(() => {
    attempts.push(delivered);
    return delivered;
  });

  // A socket that is closed, still resuming, or in furnace transit sends
  // nothing and says so. The run's single report must not be spent on an
  // attempt that never reached the server.
  game.updateGame(GAME_TICK_MS);
  expect(attempts).toHaveLength(1);
  game.updateGame(GAME_TICK_MS);
  expect(attempts).toHaveLength(2);

  delivered = true;
  game.updateGame(GAME_TICK_MS);
  expect(attempts).toHaveLength(3);

  // Delivered, so the rest of this contact run stays quiet.
  game.updateGame(GAME_TICK_MS);
  expect(attempts).toHaveLength(3);
});

test('a hull skimming the wall cannot outspend the inbound message budget', () => {
  const ship = arrangeFlight();
  ship.velocity = { x: 0, y: 0 };
  ship.angularVelocity = 0;
  ship.thrusting = false;
  ship.blinkCount = 0;
  const inside = { x: WORLD.radius - ship.r - 1, y: 0 };
  const touching = { x: WORLD.radius - ship.r + 1, y: 0 };
  expect(checkBoundaryCollision(inside, ship.r)).toBe(false);
  expect(checkBoundaryCollision(touching, ship.r)).toBe(true);
  let reports = 0;
  vi.spyOn(PlayerManager.getInstance(), 'updateNetworkState').mockImplementation(() => {
    reports += 1;
    return true;
  });

  // The wall rule floors the radius, so a hull travelling almost tangentially
  // along the rim can cross the threshold back and forth. Alternating every
  // frame is the fastest that can happen: a rising edge needs an intervening
  // frame out of contact, so one second of 60 Hz frames holds at most 30 of
  // them. Drive exactly that worst case.
  for (let frame = 0; frame < 60; frame++) {
    ship.position = frame % 2 === 0 ? { ...touching } : { ...inside };
    game.updateGame(GAME_TICK_MS);
  }

  expect(reports).toBe(30);
  // Honest gameplay traffic is 60 poses plus 30 applied-snapshot
  // acknowledgments per second, as `GAMEPLAY_MESSAGE_BUDGET`'s own docblock
  // records. The worst case above has to fit in what is left, because
  // exceeding the budget drops the connection instead of throttling it.
  const honestTrafficPerSecond = 60 + 30;
  expect(honestTrafficPerSecond + reports).toBeLessThanOrEqual(
    GAMEPLAY_MESSAGE_BUDGET.messagesPerSecond
  );

  // Alternating every frame never asks the latch to hold, because leaving
  // contact clears it anyway. Dwelling in contact is what the latch is for:
  // two frames against the wall for every frame off it leaves 20 rising edges
  // across the same second, not the 40 contact frames.
  reports = 0;
  for (let frame = 0; frame < 60; frame++) {
    ship.position = frame % 3 === 2 ? { ...inside } : { ...touching };
    game.updateGame(GAME_TICK_MS);
  }
  expect(reports).toBe(20);
  // It also cannot be sustained: every one of those contacts is a pose the
  // server refuses, and a vulnerable hull is destroyed on the first one. Only
  // a hold large enough to absorb the hit survives to graze again, and each
  // contact spills from it (`tests/unit/server/authoritative-combat.test.ts`),
  // so the rate above is a ceiling for a few frames rather than a steady state.
});

test('a new session does not inherit a latched wall contact', () => {
  const ship = arrangeFlight();
  ship.position = { x: WORLD.radius - ship.r + 1, y: 0 };
  ship.blinkCount = 0;
  expect(checkBoundaryCollision(ship.position, ship.r)).toBe(true);
  let reports = 0;
  vi.spyOn(PlayerManager.getInstance(), 'updateNetworkState').mockImplementation(() => {
    reports += 1;
    return true;
  });

  game.updateGame(GAME_TICK_MS);
  expect(reports).toBe(1);

  // Starting a session clears the latch. Without that, a pilot who ends one
  // session in contact would have the next session's first wall contact
  // swallowed, and only the pose timer — which cannot see an intermediate
  // catch-up frame — would carry it.
  const fresh = arrangeFlight();
  fresh.position = { x: WORLD.radius - fresh.r + 1, y: 0 };
  fresh.blinkCount = 0;
  expect(checkBoundaryCollision(fresh.position, fresh.r)).toBe(true);

  game.updateGame(GAME_TICK_MS);
  expect(reports).toBe(2);
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
  game.getCurrRoidBelt().replaceAll([asteroid]);

  game.updateGame(GAME_TICK_MS * 2);

  // The current multiplayer protocol leaves asteroid impact resolution to the
  // server. The client still advances visual projectiles on the same fixed
  // clock, but crossing a local rock does not destroy it optimistically.
  expect(laser.hasExploded).toBe(false);
  expect(laser.position).toEqual({ x: 100, y: 0 });
  expect(laser.distTraveled).toBe(200);
  expect(game.getCurrRoidBelt().getRoids()).toContain(asteroid);
});
