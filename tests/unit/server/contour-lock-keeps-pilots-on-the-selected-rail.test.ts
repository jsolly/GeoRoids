import { afterEach, beforeEach, expect, test } from 'vitest';
import { decodeClientCommand } from '../../../server/communication/clientCommandDecoder';
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
afterEach(() => world.dispose());

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
    const { actor, pose } = railPilot();
    for (const y of [10, 20, 30]) {
      const ship = new Ship({ position: { x: 2200, y }, kitId: actor.kitId });
      const gradient = sampleGradient(getTerrainField(), ship.position.x, ship.position.y);
      ship.angle = Math.atan2(-gradient.x, -gradient.y);
      ship.velocity = terrainCruiseVelocity(
        ship.position,
        ship.angle,
        cruiseSpeed(ship.mass, ship.maxVelocity)
      );
      world.engine.playerMotion.placeActorForTesting(
        actor.id,
        ship.position,
        world.engine.getServerTime()
      );
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

test('collecting shard and point loot preserves mass, health, speed, and the contour rail', () => {
  const { actor, state, cruise, pose, now } = railPilot();
  const velocity = contourLockVelocity(actor.position, state, cruise);
  if (!velocity) {
    throw new Error('Missing fixture rail');
  }
  expect(pose(0, state, actor.position, velocity).ok).toBe(true);
  const before = {
    mass: actor.mass,
    maxHealth: actor.maxHealth,
    health: actor.health,
    cargo: actor.cargo,
    epoch: actor.playerMotion?.epoch,
    speed: world.engine.playerMotion.legalSpeed(actor, now),
  };
  world.engine.addAsteroid({
    id: 'pickup-rock',
    position: { ...actor.position },
    velocity: { x: 0, y: 0 },
    size: 12,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 1,
    maxHealth: 1,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  });
  world.engine.handleAsteroidHit('pickup-rock', actor.id, 'laser');
  expect(
    world.engine
      .getLoot()
      .map((loot) => loot.kind)
      .sort((left, right) => left.localeCompare(right))
  ).toEqual(['points', 'shard']);
  expect(world.engine.collectLoot()).toHaveLength(2);
  expect(actor.mass).toBe(before.mass);
  expect(actor.maxHealth).toBe(before.maxHealth);
  expect(actor.health).toBe(before.health);
  expect(actor.cargo).toBeGreaterThan(before.cargo);
  expect(actor.contourLock).toEqual(state);
  expect(actor.playerMotion?.mode).toBe('free');
  expect(actor.playerMotion?.epoch).toBe(before.epoch);
  expect(world.engine.playerMotion.legalSpeed(actor, now)).toBe(before.speed);
  const nextVelocity = contourLockVelocity(actor.position, state, cruise);
  if (!nextVelocity) {
    throw new Error('Missing unchanged fixture rail');
  }
  const next = { x: actor.position.x + nextVelocity.x, y: actor.position.y + nextVelocity.y };
  expect(pose(17, state, next, nextVelocity).ok).toBe(true);
  expect(actor.contourLock).toEqual(state);
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

test('a pilot cannot select a distant rail or change its level during a continuous lock', () => {
  const { actor, state, pose } = railPilot();
  expect(pose(0, { ...state, height: state.height + 1 }).ok).toBe(false);
  expect(actor.contourLock).toBeNull();
  expect(pose(1).ok).toBe(true);
  expect(pose(2, { ...state, height: state.height + TERRAIN.CONTOUR_INTERVAL }).ok).toBe(false);
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
          collabTags: [],
          playerProjectiles: [],
        })
    ).not.toThrow();
  }
);
