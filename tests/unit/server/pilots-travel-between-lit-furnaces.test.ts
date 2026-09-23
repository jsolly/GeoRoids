/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { FurnaceField } from '../../../shared/furnaceField';
import { civicLot, pipeToTownSquare, TOWN_HEARTH } from '../../../shared/furnaces';
import {
  furnaceTravelDuration,
  furnaceTravelPose,
  nearestTravelFurnace,
  planFurnaceRoute,
} from '../../../shared/furnaceTravel';
import { GAME_TICK_MS } from '../../../shared/gameClock';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { captureSnapshot } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();
let world: GameServerWorld;
afterEach(() => world?.dispose());

function travelWorld() {
  world = new GameServerWorld();
  const pilot = world.join('Traveler');
  const actor = world.entity(pilot);
  const street = civicLot('street-1-0');
  assert(street);
  world.clearAsteroids();
  world.engine.clearSpiderField();
  actor.position = { ...street.position };
  actor.score = street.cost;
  expect(world.engine.useAbility(actor.id)).toBe(true);
  actor.position = { x: 0, y: 0 };
  return { pilot, actor, street };
}

test('a pilot rides the existing pipe, ignores flight commands and arrives in a fresh motion epoch', () => {
  const { pilot, actor, street } = travelWorld();
  const epoch = actor.playerMotion?.epoch ?? 0;
  world.send(pilot, { type: 'travelFurnace', id: pilot.id, data: { destinationId: street.id } });
  expect(pilot.socket.lastReceived('furnaceTravelResult')?.data).toEqual({
    ok: true,
    message: 'Travelling',
  });
  const transit = actor.furnaceTransit;
  assert(transit);
  expect(transit.durationMs).toBe(3_000);
  const startedEpoch = actor.playerMotion?.epoch ?? 0;
  expect(startedEpoch).toBeGreaterThan(epoch);
  expect(world.engine.travelFurnace(actor.id, street.id)).toBe('Already travelling');
  const health = actor.health;
  expect(world.engine.handleShipDamage(actor.id, 'boundary', health).applied).toBe(false);
  expect(world.engine.useAbility(actor.id)).toBe(false);
  world.send(pilot, {
    type: 'update',
    id: pilot.id,
    data: {
      position: { x: 9999, y: 9999 },
      velocity: { x: 0, y: 0 },
      angle: 0,
      thrusting: false,
      motionEpoch: startedEpoch,
      motionSequence: 1,
    },
  });
  expect(actor.position).toEqual(TOWN_HEARTH.position);
  world.engine.setOverlayHold(actor.id, false);
  expect(actor.overlayHold).toBe(true);
  const unclaimed = world.engine.dropEquipmentAt(actor.position, 'resource_tap');
  expect(world.engine.collectLoot()).toEqual([]);
  expect(world.engine.getLoot().some((drop) => drop.id === unclaimed.id)).toBe(true);
  expect(world.engine.spawnPlayerLaser(actor.id, actor.position, { x: 3, y: 0 })).toBeNull();
  expect(
    world.engine.playerMotion.acceptFreePose(
      pilot.socket,
      {
        position: { x: 9999, y: 9999 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        thrusting: false,
        epoch: startedEpoch,
        sequence: 2,
      },
      world.engine.getServerTime()
    ).ok
  ).toBe(false);
  for (let tick = 0; tick < 10; tick++) {
    world.engine.advanceOneFrame();
  }
  const halfway = furnaceTravelPose(transit, transit.startedAt + 10 * GAME_TICK_MS);
  expect(actor.position.x).toBeCloseTo(halfway.position.x);
  expect(actor.position.y).toBeCloseTo(halfway.position.y);
  expect(actor.position).not.toEqual(street.position);
  for (let tick = 10; tick < Math.ceil(transit.durationMs / GAME_TICK_MS); tick++) {
    world.engine.advanceOneFrame();
  }
  expect(actor.furnaceTransit).toBeNull();
  expect(actor.position.x).toBeCloseTo(street.position.x);
  expect(actor.position.y).toBeCloseTo(street.position.y);
  expect(actor.playerMotion?.epoch).toBeGreaterThan(startedEpoch);
  expect(actor.playerMotion?.anchor).toEqual(actor.position);
  expect(actor.health).toBe(health);
  world.broadcastGameState();
  const snapshot = captureSnapshot(world.snapshot(pilot));
  validateSnapshotDto(snapshot);
  expect(snapshot.entities.find((entry) => entry.id === actor.id)?.furnaceTransit).toBeNull();
  expect(snapshot.serverTime).toBeGreaterThan(0);
});

test('spoofed, distant, dark and dead travel requests cannot take motion ownership', () => {
  const { pilot, actor, street } = travelWorld();
  const other = world.join('Other');
  world.send(other, { type: 'travelFurnace', id: pilot.id, data: { destinationId: street.id } });
  expect(actor.furnaceTransit).toBeUndefined();
  expect(world.engine.travelFurnace(actor.id, 'street-1-1')).toBe('That furnace is not lit');
  expect(world.engine.travelFurnace(actor.id, TOWN_HEARTH.id)).toBe('Choose another lit furnace');
  actor.position = { x: TOWN_HEARTH.radius + 1, y: 0 };
  expect(world.engine.travelFurnace(actor.id, street.id)).toBe('Move onto a lit furnace');
  actor.position = { x: 0, y: 0 };
  actor.health = 0;
  expect(world.engine.travelFurnace(actor.id, street.id)).toBe('Your ship is not ready to travel');
});

test('travelling releases an armed coupling and disconnecting completes the ride before resume', () => {
  const { pilot, actor, street } = travelWorld();
  const cargo: AsteroidData = {
    id: 'cargo',
    position: { x: 80, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 25,
    health: 75,
    maxHealth: 75,
    rotation: 0,
    angularVelocity: 0,
    jaggedness: 0.2,
    offsets: [1, 1, 1, 1],
    vertices: 4,
  };
  world.engine.addAsteroid(cargo);
  actor.kitId = 'hauler';
  actor.equipment = ['boost_coupling'];
  actor.haulerUtility = 'boost_coupling';
  actor.harpoonTargetId = cargo.id;
  actor.harpoonLatchPos = { ...cargo.position };
  cargo.boost = { phase: 'armed', ownerId: actor.id, angle: 0, couplings: [actor.id] };
  expect(world.engine.travelFurnace(actor.id, street.id)).toBeUndefined();
  expect(actor.harpoonTargetId).toBeNull();
  expect(actor.harpoonLatchPos).toBeUndefined();
  expect(cargo.boost).toBeNull();
  expect(world.engine.transportClosed(pilot.socket)).toBe(true);
  expect(actor.furnaceTransit).toBeNull();
  expect(actor.position).toEqual(street.position);
  expect(actor.overlayHold).toBe(false);
});

test('routes between parent and child use their shared pipe without detouring through town', () => {
  const child = civicLot('street-2-0');
  const parent = civicLot('street-1-0');
  assert(child && parent);
  const direct = planFurnaceRoute(child.id, parent.id);
  expect(direct[0]).toEqual(child.position);
  expect(direct.at(-1)).toEqual(parent.position);
  expect(direct).not.toContainEqual(TOWN_HEARTH.position);
  expect(planFurnaceRoute(parent.id, child.id)).toEqual([...direct].reverse());
  expect(planFurnaceRoute(child.id, TOWN_HEARTH.id)).toEqual(pipeToTownSquare(child.id));
  const field = new FurnaceField();
  expect(nearestTravelFurnace({ x: TOWN_HEARTH.radius, y: 0 }, field)?.id).toBe(TOWN_HEARTH.id);
  expect(nearestTravelFurnace({ x: TOWN_HEARTH.radius + 1, y: 0 }, field)).toBeUndefined();
  field.light(parent.id);
  expect(
    nearestTravelFurnace({ x: parent.position.x + parent.radius, y: parent.position.y }, field)?.id
  ).toBe(parent.id);
  expect(
    nearestTravelFurnace({ x: parent.position.x + parent.radius + 1, y: parent.position.y }, field)
  ).toBeUndefined();
});

test('a mid-ride checkpoint saves the safe arrival instead of a position inside a pipe', () => {
  const store = new WorldStore(':memory:');
  const engine = new GameEngine(42, undefined, new InlineWorldPersistence(store));
  try {
    const socket = new RecordingSocket();
    const actor = engine.addPlayer('rider', 'Rider', socket, undefined, 'scout');
    actor.asteroidInteractions = 1;
    const registered = engine.registerPilot(actor, socket);
    assert(registered.ok);
    const street = civicLot('street-1-0');
    assert(street);
    actor.position = { ...street.position };
    actor.score = street.cost;
    expect(engine.useAbility(actor.id)).toBe(true);
    actor.position = { x: 0, y: 0 };
    expect(engine.travelFurnace(actor.id, street.id)).toBeUndefined();
    engine.advanceOneFrame();
    engine.checkpointWorld();
    const saved = store.loadPilots().find((pilot) => pilot.id === actor.id);
    expect(saved?.position).toEqual(street.position);
    expect(saved?.velocity).toEqual({ x: 0, y: 0 });
    expect(saved).not.toHaveProperty('furnaceTransit');
    expect(actor.furnaceTransit).toBeTruthy();
  } finally {
    engine.stopGameLoop();
    store.close();
  }
});

test('furnace rides take at least three seconds and scale with pipe length up to eight', () => {
  const origin = { x: 0, y: 0 };
  expect(furnaceTravelDuration([origin, { x: 1_000, y: 0 }])).toBe(3_000);
  expect(furnaceTravelDuration([origin, { x: 9_000, y: 0 }, { x: 9_000, y: 6_000 }])).toBe(5_000);
  expect(furnaceTravelDuration([origin, { x: 30_000, y: 0 }])).toBe(8_000);
});
