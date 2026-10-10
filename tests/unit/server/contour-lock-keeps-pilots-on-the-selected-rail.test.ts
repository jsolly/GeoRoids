import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';
import { logger } from '../../../setup/serverLogger';
import {
  CONTOUR_LOCK,
  contourLockDistance,
  contourLockVelocity,
} from '../../../shared/contourLock';
import { cruiseSpeed } from '../../../shared/shipFlight';
import { SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { ContourLockState, Position } from '../../../shared-types';
import { Ship } from '../../../src/entities/ship/Ship';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { sampleGradient, sampleHeight } from '../../../src/physics/terrain/heightfield';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { getTerrainField } from '../../../src/physics/terrain/terrainSession';
import { terrainCruiseVelocity } from '../../../src/physics/terrain/terrainTravel';
import { RecordingSocket } from '../../support/recordingSocket';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
beforeEach(() => {
  world = new GameServerWorld();
});
afterEach(() => {
  world.dispose();
  vi.restoreAllMocks();
});

function railPilot() {
  const pilot = world.join('Rail pilot', { x: 2250, y: 0 });
  const actor = world.entity(pilot);
  world.clearAsteroids();
  const state: ContourLockState = {
    height:
      Math.round(
        sampleHeight(getTerrainField(), actor.position.x, actor.position.y) /
          TERRAIN.CONTOUR_INTERVAL
      ) * TERRAIN.CONTOUR_INTERVAL,
    direction: 1,
  };
  // Project the fixture onto a canonical visible level using bounded Newton steps.
  for (let step = 0; step < 6; step++) {
    const gradient = sampleGradient(getTerrainField(), actor.position.x, actor.position.y);
    const error =
      state.height - sampleHeight(getTerrainField(), actor.position.x, actor.position.y);
    const scale = error / (gradient.x ** 2 + gradient.y ** 2);
    actor.position = {
      x: actor.position.x + gradient.x * scale,
      y: actor.position.y + gradient.y * scale,
    };
  }
  world.engine.playerMotion.placeActorForTesting(
    actor.id,
    actor.position,
    world.engine.getServerTime()
  );
  const cruise = cruiseSpeed(actor.mass, getShipKit(actor.kitId).maxVelocity);
  const now = world.engine.getServerTime();
  let sequence = 0;
  const pose = (
    at: number,
    contourLock: ContourLockState | null = state,
    position: Position = actor.position,
    velocity: Position = { x: 0, y: 0 }
  ) =>
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      {
        epoch: actor.playerMotion?.epoch ?? 0,
        sequence: ++sequence,
        position: { ...position },
        velocity,
        angle: 0,
        thrusting: true,
        contourLock,
      },
      now + at
    );
  return { pilot, actor, state, cruise, now, pose };
}

test('a pilot follows curved contour guidance continuously with no charge or timer', () => {
  const { actor, state, cruise, pose } = railPilot();
  for (let frame = 1; frame <= 600; frame++) {
    const velocity = contourLockVelocity(actor.position, state, cruise);
    if (!velocity) {
      throw new Error('Lost fixture contour');
    }
    const position = { x: actor.position.x + velocity.x, y: actor.position.y + velocity.y };
    const outcome = pose((frame * 1000) / 60, state, position, velocity);
    expect(outcome.ok, JSON.stringify({ outcome, frame, position: actor.position })).toBe(true);
    expect(contourLockDistance(actor.position, state)).toBeLessThan(CONTOUR_LOCK.railTolerance);
  }
  expect(actor.contourLock).toEqual(state);
});

test('a ship accelerates into a nearby contour within the acquisition deadline', () => {
  const { actor, state, pose } = railPilot();
  const gradient = sampleGradient(getTerrainField(), actor.position.x, actor.position.y);
  const offset = state;
  const magnitude = Math.hypot(gradient.x, gradient.y);
  actor.position = {
    x: actor.position.x - (gradient.x / magnitude) * 30,
    y: actor.position.y - (gradient.y / magnitude) * 30,
  };
  const ship = new Ship({
    kitId: actor.kitId,
    position: { ...actor.position },
    isLocalPlayer: true,
  });
  ship.contourLock = offset;
  for (let frame = 1; frame <= 60; frame++) {
    ship.update();
    const outcome = pose((frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
    expect(outcome.ok, JSON.stringify({ outcome, frame, position: actor.position })).toBe(true);
  }
  expect(actor.contourLock).toEqual(offset);
  expect(contourLockDistance(actor.position, offset)).toBeLessThan(CONTOUR_LOCK.railTolerance);
});

test.each([0.1, 1])(
  'a pilot crossing a contour at %s cruise can publish lock intent before the next movement tick',
  (speedFraction) => {
    const { actor, cruise, pose } = railPilot();
    const ship = new Ship({ kitId: actor.kitId, position: { ...actor.position } });
    const gradient = sampleGradient(getTerrainField(), ship.position.x, ship.position.y);
    ship.angle = Math.atan2(-gradient.y, gradient.x);
    ship.velocity = {
      x: Math.cos(ship.angle) * cruise * speedFraction,
      y: -Math.sin(ship.angle) * cruise * speedFraction,
    };
    expect(pose(0, null, ship.position, ship.velocity).ok).toBe(true);
    const position = { ...ship.position };
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
    expect(ship.toggleContourLock()).toBe(true);
    expect(ship.position).toEqual(position);
    expect(Math.hypot(ship.velocity.x, ship.velocity.y)).toBeCloseTo(speed);
    expect(ship.angle).toBeCloseTo(Math.atan2(-ship.velocity.y, ship.velocity.x));
    // No Ship.update occurs between the input event and this network pose.
    expect(pose(1, ship.contourLock, ship.position, ship.velocity).ok).toBe(true);
    const lock = ship.contourLock;
    for (let frame = 1; frame <= 90; frame++) {
      ship.update();
      const outcome = pose(1 + (frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
      expect(outcome.ok, JSON.stringify({ frame, outcome })).toBe(true);
      expect(actor.contourLock).toEqual(lock);
      expect(ship.contourLock).toEqual(lock);
    }
  }
);

test('a buffered curved rail route retains the server-stall travel credit', () => {
  const { actor, state, cruise, pose, now } = railPilot();
  expect(pose(0).ok).toBe(true);
  let position = { ...actor.position };
  let velocity = { x: 0, y: 0 };
  for (let frame = 0; frame < 60; frame++) {
    const next = contourLockVelocity(position, state, cruise);
    if (!next) {
      throw new Error('Missing fixture rail');
    }
    velocity = next;
    position = { x: position.x + velocity.x, y: position.y + velocity.y };
  }
  world.engine.playerMotion.recordBlockedSpan(now, now + 1000);
  const outcome = pose(1000, state, position, velocity);
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
});

test('a fabricated level between visible contours is refused', () => {
  const { state, pose } = railPilot();
  expect(pose(0, { ...state, height: state.height + TERRAIN.CONTOUR_INTERVAL / 2 }).ok).toBe(false);
});

test('a claimed forward velocity cannot hide backwards rail displacement', () => {
  const { actor, state, cruise, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  const backwards = contourLockVelocity(actor.position, { ...state, direction: -1 }, cruise);
  const forward = contourLockVelocity(actor.position, state, cruise);
  if (!backwards || !forward) {
    throw new Error('Missing fixture guidance');
  }
  const position = { x: actor.position.x + backwards.x, y: actor.position.y + backwards.y };
  expect(pose(17, state, position, forward).ok).toBe(false);
});

test.each([
  { displacement: 0.259, speed: 0 },
  { displacement: 1.264, speed: 0.812 },
])('a new lock tolerates the final $displacement units of free flight only once', (residual) => {
  const { actor, state, cruise, pose } = railPilot();
  const forward = contourLockVelocity(actor.position, state, cruise);
  if (!forward) {
    throw new Error('Missing fixture guidance');
  }
  const magnitude = Math.hypot(forward.x, forward.y);
  const dx = (forward.x / magnitude) * residual.displacement;
  const dy = (forward.y / magnitude) * residual.displacement;
  const velocity = {
    x: (forward.x / magnitude) * residual.speed,
    y: (forward.y / magnitude) * residual.speed,
  };
  // This packet contains free flight before the button press plus new lock intent.
  const position = { x: actor.position.x - dx, y: actor.position.y - dy };
  expect(pose(30, state, position, velocity).ok).toBe(true);
  const backwards = { x: actor.position.x - dx, y: actor.position.y - dy };
  const rejected = pose(60, state, backwards, velocity);
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) {
    expect(rejected.envelope?.check).toBe('rail');
  }
});

test('a new lock cannot disguise a larger backwards jump as free-flight residue', () => {
  const { actor, state, cruise, pose } = railPilot();
  const forward = contourLockVelocity(actor.position, state, cruise);
  if (!forward) {
    throw new Error('Missing fixture guidance');
  }
  const position = { x: actor.position.x - forward.x, y: actor.position.y - forward.y };
  expect(pose(30, state, position, { x: 0, y: 0 }).ok).toBe(false);
});

test.each([1, 3])(
  'a cruising pilot catches a rail after %s unreported free-flight ticks',
  (ticks) => {
    const { actor, pose, now } = railPilot();
    for (const y of [10, 20, 30]) {
      const ship = new Ship({ position: { x: 2200, y }, kitId: actor.kitId });
      const gradient = sampleGradient(getTerrainField(), ship.position.x, ship.position.y);
      ship.angle = Math.atan2(-gradient.x, -gradient.y);
      ship.velocity = terrainCruiseVelocity(
        ship.position,
        ship.angle,
        cruiseSpeed(ship.mass, ship.maxVelocity)
      );
      world.engine.playerMotion.placeActorForTesting(actor.id, ship.position, now);
      actor.velocity = { ...ship.velocity };
      for (let frame = 0; frame < ticks; frame++) {
        ship.update();
      }
      expect(ship.toggleContourLock()).toBe(true);
      ship.update();
      const outcome = pose(
        ((ticks + 1) * 1000) / 60,
        ship.contourLock,
        ship.position,
        ship.velocity
      );
      expect(outcome.ok, JSON.stringify({ y, ticks, outcome })).toBe(true);
      expect(actor.contourLock).toEqual(ship.contourLock);
    }
  }
);

test('a forward velocity cannot hide a sideways shortcut during capture', () => {
  const { actor, state, cruise, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  const gradient = sampleGradient(getTerrainField(), actor.position.x, actor.position.y);
  const magnitude = Math.hypot(gradient.x, gradient.y);
  const position = {
    x: actor.position.x + (gradient.x / magnitude) * 12,
    y: actor.position.y + (gradient.y / magnitude) * 12,
  };
  const velocity = contourLockVelocity(position, state, cruise);
  if (!velocity) {
    throw new Error('Missing fixture rail');
  }
  const outcome = pose(100, state, position, velocity);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.envelope?.check).toBe('rail');
  }
});

test('equipment loot preserves the contour lock and current motion epoch', () => {
  const { actor, state, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  const epoch = actor.playerMotion?.epoch;
  const mass = actor.mass;
  world.engine.dropEquipmentAt(actor.position, 'survey_probe');
  expect(world.engine.collectLoot()).toHaveLength(1);
  expect(actor.mass).toBe(mass);
  expect(actor.contourLock).toEqual(state);
  expect(actor.playerMotion?.epoch).toBe(epoch);
  expect(pose(17).ok).toBe(true);
});

test('a crew laser passing through a hull is not a collision', () => {
  const { actor, pilot, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  const shot = world.engine.spawnLaser(
    pilot.id,
    { x: actor.position.x - 80, y: actor.position.y },
    { x: 120, y: 0 }
  );
  if (!shot) {
    throw new Error('Missing fixture shot');
  }
  world.engine.advanceLasersAndResolveHits();
  expect(actor.contourLock).not.toBeNull();
  expect(shot.hasExploded).toBe(false);
});

test('protected asteroid contact releases the rail without taking health', () => {
  const { actor, pilot, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  const health = actor.health;
  const epoch = actor.playerMotion?.epoch;
  actor.spawnProtectionTimer = 30;
  world.hitAsteroid(pilot);
  expect(actor.health).toBe(health);
  expect(actor.contourLock).toBeNull();
  expect(actor.playerMotion?.epoch).not.toBe(epoch);
});

test.each([0, 30])(
  'a ricochet respects protection %s before changing a locked ship',
  (protection) => {
    const { actor, pilot, pose } = railPilot();
    expect(pose(0).ok).toBe(true);
    actor.spawnProtectionTimer = protection;
    const health = actor.health;
    const shot = world.engine.spawnLaser(
      pilot.id,
      { x: actor.position.x - 80, y: actor.position.y },
      { x: 120, y: 0 }
    );
    if (!shot) {
      throw new Error('Missing fixture shot');
    }
    shot.bounces = 1;
    world.engine.advanceLasersAndResolveHits();
    if (protection) {
      expect(actor.contourLock).not.toBeNull();
      expect(shot.hasExploded).toBe(false);
      expect(actor.health).toBe(health);
    } else {
      expect(actor.contourLock).toBeNull();
      expect(shot.hasExploded).toBe(true);
      expect(actor.health).toBeLessThan(health);
    }
  }
);

test('a pilot cannot select a distant rail or skip a level during a continuous lock', () => {
  const { actor, state, pose } = railPilot();
  expect(pose(0, { ...state, height: state.height + 1 }).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
  expect(pose(1).ok).toBe(true);
  expect(pose(2, { ...state, height: state.height + 2 * TERRAIN.CONTOUR_INTERVAL }).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
});

test('acquisition must converge within its deadline instead of hovering beside the rail', () => {
  const { actor, state, pose } = railPilot();
  const gradient = sampleGradient(getTerrainField(), actor.position.x, actor.position.y);
  const offset = state;
  const magnitude = Math.hypot(gradient.x, gradient.y);
  actor.position = {
    x: actor.position.x - (gradient.x / magnitude) * 20,
    y: actor.position.y - (gradient.y / magnitude) * 20,
  };
  expect(pose(0, offset).ok).toBe(true);
  expect(pose(CONTOUR_LOCK.acquisitionMs, offset).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
});

test('the rail speed cannot be aimed across a contour or carried after release', () => {
  const { actor, state, cruise, pose } = railPilot();
  const velocity = contourLockVelocity(actor.position, state, cruise);
  if (!velocity) {
    throw new Error('Missing fixture rail');
  }
  expect(pose(0, state, actor.position, { x: -velocity.y, y: velocity.x }).ok).toBe(false);
  expect(pose(1, state, actor.position, velocity).ok).toBe(true);
  expect(pose(2, null, actor.position, velocity).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
});

test('release can immediately recapture, while disconnect, impulse, and death clear the lock', () => {
  const { actor, pilot, state, pose, now } = railPilot();
  const motion = world.engine.playerMotion;
  expect(pose(0).ok).toBe(true);
  expect(pose(1, null).ok).toBe(true);
  expect(pose(2).ok).toBe(true);
  motion.applyExternalImpulse(actor.id, now + 3);
  expect(actor.contourLock).toBeNull();
  expect(pose(4).ok).toBe(true);
  motion.transportClosed(pilot.socket, now + 5);
  expect(actor.contourLock).toBeNull();
  expect(motion.resume(pilot.resumeToken, new RecordingSocket(), now + 6).ok).toBe(true);
  expect(actor.contourLock).toBeNull();
  actor.contourLock = state;
  actor.health = 0;
  motion.invalidateLife(actor.id, now + 7);
  expect(actor.contourLock).toBeNull();
});

test.each(['scout', 'hauler'] as const)(
  '%s reports contour speed, fires, and turns across contours without server corrections',
  (kitId) => {
    const pilot = world.join('Contour pilot', { x: 2250, y: 0 }, { kitId });
    const actor = world.entity(pilot);
    world.clearAsteroids();
    const ship = new Ship({ kitId, position: { ...actor.position }, isLocalPlayer: true });
    const gradient = sampleGradient(getTerrainField(), ship.position.x, ship.position.y);
    ship.angle = Math.atan2(-gradient.x, -gradient.y);
    const now = world.engine.getServerTime();
    let fastest = 0;
    for (let frame = 1; frame <= 480; frame++) {
      if (frame % 120 === 0) {
        ship.angle += Math.PI / 2;
      }
      ship.update();
      ship.angle = Math.atan2(Math.sin(ship.angle), Math.cos(ship.angle));
      fastest = Math.max(fastest, Math.hypot(ship.velocity.x, ship.velocity.y));
      const outcome = world.engine.playerMotion.acceptFreePose(
        pilot.socket,
        {
          epoch: actor.playerMotion?.epoch ?? 0,
          sequence: frame,
          position: { ...ship.position },
          velocity: { ...ship.velocity },
          angle: ship.angle,
          thrusting: true,
        },
        now + (frame * 1000) / 60
      );
      expect(outcome.ok, JSON.stringify({ outcome, frame, position: actor.position })).toBe(true);
      if (frame % 30 === 0) {
        const laser = ship.generateLaser();
        expect(
          world.engine.spawnPlayerLaser(
            actor.id,
            laser.position,
            laser.velocity,
            now + (frame * 1000) / 60
          )
        ).not.toBeNull();
      }
    }
    expect(fastest).toBeGreaterThan(getShipKit(kitId).maxVelocity * 1.1);
  }
);

test.each(['constructor', '__proto__', 'unexpected'])(
  'an extra %s field in a contour command cannot poison other pilots snapshots',
  (key) => {
    const { actor, state, pose } = railPilot();
    expect(pose(0).ok).toBe(true);
    const malformed = { ...state, [key]: { nested: { payload: 'invalid lock metadata' } } };
    const decoded = decodeClientCommand({
      type: 'update',
      id: actor.id,
      data: { contourLock: malformed },
    });
    expect(decoded.ok).toBe(false);
    expect(pose(16, malformed).ok).toBe(false);
    expect(actor.contourLock).toEqual(state);
    expect(
      () =>
        new SnapshotEncoder({
          ...world.engine.getGameState(),
          playerProjectiles: [],
        })
    ).not.toThrow();
  }
);

test('a settled pilot glides onto the adjacent rail and the server accepts the whole transition', () => {
  const { actor, state, pose } = railPilot();
  const ship = new Ship({ kitId: actor.kitId, position: { ...actor.position } });
  ship.contourLock = state;
  expect(pose(0).ok).toBe(true);
  const start = { ...ship.position };
  expect(ship.hopContour({ x: -1, y: 0 })).toBe(true);
  expect(ship.position).toEqual(start);
  expect(ship.contourLock).toEqual({
    height: state.height - TERRAIN.CONTOUR_INTERVAL,
    direction: state.direction,
  });
  expect(pose(1, ship.contourLock, ship.position, ship.velocity).ok).toBe(true);
  const target = ship.contourLock;
  expect(ship.hopContour({ x: -1, y: 0 })).toBe(false);
  for (let frame = 1; frame <= 90; frame++) {
    ship.update();
    const outcome = pose(1 + (frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
    expect(outcome.ok, JSON.stringify({ frame, outcome })).toBe(true);
  }
  expect(actor.contourLock).toEqual(target);
  if (!target) {
    throw new Error('Expected hop target');
  }
  expect(contourLockDistance(actor.position, target)).toBeLessThan(CONTOUR_LOCK.railTolerance);
});

test('a hop cannot start another acquisition in mid-glide', () => {
  const { actor, state, pose } = railPilot();
  expect(pose(0).ok).toBe(true);
  expect(pose(3, { height: state.height - TERRAIN.CONTOUR_INTERVAL, direction: 1 }).ok).toBe(true);
  expect(pose(4, state).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
});

test('a buffered flick can catch a rail that came within reach after the last accepted pose', () => {
  world.dispose();
  world = new GameServerWorld(TERRAIN.DEFAULT_SEED);
  const { actor, cruise, now, pose } = railPilot();
  const old: ContourLockState = { height: 0.08, direction: 1 };
  const start = { x: -4995.842222553734, y: -4996.116910407352 };
  world.engine.playerMotion.placeActorForTesting(actor.id, start, now);
  const ship = new Ship({ kitId: actor.kitId, position: { ...start } });
  ship.contourLock = old;
  const velocity = contourLockVelocity(start, old, cruise);
  if (!velocity) {
    throw new Error('Missing initial rail');
  }
  ship.velocity = velocity;
  ship.angle = Math.atan2(-velocity.y, velocity.x);
  expect(pose(0, old, start, velocity).ok).toBe(true);
  const candidate: ContourLockState = { height: 0, direction: 1 };
  expect(contourLockDistance(start, candidate)).toBeGreaterThan(CONTOUR_LOCK.hopRadius);
  for (let frame = 0; frame < 2; frame++) {
    ship.update();
  }
  expect(contourLockDistance(ship.position, candidate)).toBeGreaterThan(CONTOUR_LOCK.captureRadius);
  expect(contourLockDistance(ship.position, candidate)).toBeLessThan(CONTOUR_LOCK.hopRadius);
  expect(ship.hopContour({ x: -0.8967584163341465, y: -0.44252044329485324 })).toBe(true);
  expect(ship.contourLock).toEqual(candidate);
  const outcome = pose((2 * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  for (let frame = 3; frame <= 90; frame++) {
    ship.update();
    const result = pose((frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
    expect(result.ok, JSON.stringify({ frame, result })).toBe(true);
  }
  expect(actor.contourLock).toEqual(candidate);
});

test.each([0, 1])('a curved hop can report its new rail after %s movement ticks', (ticks) => {
  world.dispose();
  world = new GameServerWorld(TERRAIN.DEFAULT_SEED);
  const { actor, cruise, now, pose } = railPilot();
  const old: ContourLockState = { height: 0.16, direction: 1 };
  const start = { x: -5003.3253003798745, y: -651.5074246238948 };
  world.engine.playerMotion.placeActorForTesting(actor.id, start, now);
  const ship = new Ship({ kitId: actor.kitId, position: { ...start } });
  ship.contourLock = old;
  const velocity = contourLockVelocity(start, old, cruise);
  if (!velocity) {
    throw new Error('Missing initial rail');
  }
  ship.velocity = velocity;
  ship.angle = Math.atan2(-velocity.y, velocity.x);
  expect(pose(0, old, start, velocity).ok).toBe(true);
  expect(ship.hopContour({ x: -0.4161468365471424, y: 0.9092974268256817 })).toBe(true);
  expect(ship.contourLock).toEqual({ height: 0.08, direction: 1 });
  for (let frame = 0; frame < ticks; frame++) {
    ship.update();
  }
  const result = pose(1 + (ticks * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
  expect(result.ok, JSON.stringify(result)).toBe(true);
});

test.each(['same', 'adjacent'] as const)(
  'a settled pilot can reverse onto the %s rail without teleporting',
  (route) => {
    const { actor, state, cruise, pose } = railPilot();
    const ship = new Ship({ kitId: actor.kitId, position: { ...actor.position } });
    ship.contourLock = state;
    const forward = contourLockVelocity(ship.position, state, cruise);
    if (!forward) {
      throw new Error('Missing fixture guidance');
    }
    ship.velocity = forward;
    expect(pose(0, state, ship.position, ship.velocity).ok).toBe(true);
    const start = { ...ship.position };
    const gradient = sampleGradient(getTerrainField(), start.x, start.y);
    const magnitude = Math.hypot(gradient.x, gradient.y);
    const flick =
      route === 'same'
        ? { x: -forward.x, y: -forward.y }
        : {
            x: (-gradient.x + gradient.y * 0.6) / magnitude,
            y: (-gradient.y - gradient.x * 0.6) / magnitude,
          };
    expect(ship.hopContour(flick)).toBe(true);
    expect(ship.position).toEqual(start);
    expect(ship.contourLock).toEqual({
      height: route === 'same' ? state.height : state.height - TERRAIN.CONTOUR_INTERVAL,
      direction: -1,
    });
    expect(pose(1, ship.contourLock, ship.position, ship.velocity).ok).toBe(true);
    const target = ship.contourLock;
    for (let frame = 1; frame <= 60; frame++) {
      ship.update();
      const result = pose(1 + (frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
      expect(result.ok, JSON.stringify({ frame, result })).toBe(true);
    }
    expect(actor.contourLock).toEqual(target);
  }
);

test.each([
  { x: -5498.79035132918, y: -5497.784770565292, height: 0.24, direction: 1 as const },
  { x: -5498.79035132918, y: -5497.784770565292, height: 0.24, direction: -1 as const },
  { x: -5492.069073525674, y: 1996.0205480837283, height: -0.56, direction: 1 as const },
  { x: -5492.069073525674, y: 1996.0205480837283, height: -0.56, direction: -1 as const },
])(
  'a collision-free pilot stays locked through curved contour $height for forty seconds in direction $direction',
  (fixture) => {
    world.dispose();
    world = new GameServerWorld(TERRAIN.DEFAULT_SEED);
    const { actor, pose, now } = railPilot();
    const ship = new Ship({
      kitId: actor.kitId,
      position: { x: fixture.x, y: fixture.y },
    });
    const lock: ContourLockState = { height: fixture.height, direction: fixture.direction };
    world.engine.playerMotion.placeActorForTesting(actor.id, ship.position, now);
    ship.contourLock = lock;
    expect(pose(0, lock, ship.position, ship.velocity).ok).toBe(true);
    for (let frame = 1; frame <= 2400; frame++) {
      ship.update();
      if (frame % 3 === 0) {
        const outcome = pose((frame * 1000) / 60, ship.contourLock, ship.position, ship.velocity);
        expect(outcome.ok, JSON.stringify({ frame, outcome, position: ship.position })).toBe(true);
      }
      expect(ship.contourLock, `client released at frame ${frame}`).toEqual(lock);
      expect(actor.contourLock, `server released at frame ${frame}`).toEqual(lock);
      expect(contourLockDistance(ship.position, lock)).toBeLessThan(CONTOUR_LOCK.railTolerance);
    }
  }
);

test.each(['distance', 'heading', 'route'] as const)(
  'a rejected contour %s records its release reason once',
  (failure) => {
    const { actor, state, cruise, pose, now } = railPilot();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    expect(pose(0).ok).toBe(true);
    const forward = contourLockVelocity(actor.position, state, cruise);
    if (!forward) {
      throw new Error('Missing fixture guidance');
    }
    const position =
      failure === 'route'
        ? { x: actor.position.x - forward.x, y: actor.position.y - forward.y }
        : failure === 'distance'
          ? { x: actor.position.x + 100, y: actor.position.y + 100 }
          : { x: actor.position.x + forward.x, y: actor.position.y + forward.y };
    const velocity = failure === 'heading' ? { x: -forward.x, y: -forward.y } : forward;
    const rejected = pose(1000, state, position, velocity);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) {
      throw new Error('Expected rejection');
    }
    if (failure === 'route') {
      expect(rejected.envelope?.check).toBe('rail');
    } else {
      expect(rejected.contour).toMatchObject({
        reason: `rail-${failure}`,
        position,
        velocity,
        lock: state,
        allowedDistance: 6,
        acquisitionAgeMs: 1000,
      });
      expect(rejected.contour?.gradientMagnitude).toBeGreaterThan(0);
    }
    world.engine.playerMotion.releaseContourLock(actor.id, now + 1000);
    const releases = info.mock.calls.filter(([, event]) => event === 'contour_lock_released');
    expect(releases).toHaveLength(1);
    expect(releases[0]?.[2]).toMatchObject({
      playerId: actor.id,
      reason: `rail-${failure}`,
      lock: state,
    });
    expect(actor.contourLock).toBeNull();
  }
);

test('a departing locked pilot records one terminal release before ownership is removed', () => {
  const { pilot, actor, pose, state } = railPilot();
  expect(pose(0).ok).toBe(true);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  world.core.handleClientMessage({ type: 'leave', id: actor.id }, pilot.socket);
  world.engine.playerMotion.transportClosed(pilot.socket, world.engine.getServerTime());
  const releases = info.mock.calls.filter(([, event]) => event === 'contour_lock_released');
  expect(releases).toHaveLength(1);
  expect(releases[0]?.[2]).toMatchObject({ playerId: actor.id, reason: 'removed', lock: state });
  expect(world.engine.getPlayer(actor.id)).toBeUndefined();
});
