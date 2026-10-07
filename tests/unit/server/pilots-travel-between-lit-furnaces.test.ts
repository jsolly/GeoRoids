/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, expect, test } from 'vitest';
import { FurnaceField } from '../../../shared/furnaceField';
import { civicLot, pipeToTownSquare, TOWN_HEARTH } from '../../../shared/furnaces';
import {
  furnaceTravelDuration,
  nearestTravelFurnace,
  planFurnaceRoute,
} from '../../../shared/furnaceTravel';
import type { AsteroidData } from '../../../shared-types';
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

test('furnace rides take at least three seconds and scale with pipe length up to eight', () => {
  const origin = { x: 0, y: 0 };
  expect(furnaceTravelDuration([origin, { x: 1_000, y: 0 }])).toBe(3_000);
  expect(furnaceTravelDuration([origin, { x: 9_000, y: 0 }, { x: 9_000, y: 6_000 }])).toBe(5_000);
  expect(furnaceTravelDuration([origin, { x: 30_000, y: 0 }])).toBe(8_000);
});
