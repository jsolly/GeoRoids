import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SATELLITE } from '../../../../src/constants';
import {
  GameServerWorld,
  useQuietServerConsole,
  type Pilot,
} from '../support/gameServerWorld';

useQuietServerConsole();

function latestSatellites(pilot: Pilot) {
  const state = pilot.socket.lastReceived('gameState');
  const data = state?.data as { satellites?: Array<{ id: string; health: number; position: { x: number; y: number } }> };
  return data?.satellites ?? [];
}

describe('Hostile NPCs are shared across two clients', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: 0, y: 0 }, { factionId: 'ion' });
    bob = world.join('Bob', { x: 40, y: 0 }, { factionId: 'ember' });
    world.wearOffJoinInvulnerability();
    world.broadcastGameState();
  });

  afterEach(() => {
    world.dispose();
  });

  test('both pilots receive the same ambient NPC snapshot', () => {
    const aliceSats = latestSatellites(alice);
    const bobSats = latestSatellites(bob);

    expect(aliceSats.length).toBeGreaterThanOrEqual(SATELLITE.AMBIENT_COUNT);
    expect(bobSats.map((sat) => sat.id).sort()).toEqual(aliceSats.map((sat) => sat.id).sort());
    expect(bobSats.map((sat) => sat.health)).toEqual(
      aliceSats.map((sat) => sat.health)
    );
  });

  test('one pilot destroying an NPC updates score, loot, and the other client', () => {
    const target = latestSatellites(alice)[0];
    expect(target).toBeDefined();

    world.shootSatellite(alice, target!.id, SATELLITE.HEALTH);
    world.broadcastGameState();

    expect(world.entity(alice).score).toBe(SATELLITE.POINTS);
    expect(world.engine.getLoot().length).toBeGreaterThan(0);

    const aliceAfter = latestSatellites(alice).find((sat) => sat.id === target!.id);
    const bobAfter = latestSatellites(bob).find((sat) => sat.id === target!.id);
    expect(aliceAfter?.health).toBe(0);
    expect(bobAfter?.health).toBe(0);
  });
});
