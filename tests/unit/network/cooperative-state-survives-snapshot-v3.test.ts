import { expect, test } from 'vitest';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { Player } from '../../../src/entities/player/Player';
import { getWorldCampaign, setWorldCampaign } from '../../../src/network/worldCampaign';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

test('v3 keyframe, delta and clear preserve campaign, downed deadlines and physical shipment provenance', () => {
  const world = snapshotFixture();
  const pilot = world.entities[0];
  const rock = world.asteroids[0];
  if (!pilot || !rock) {
    throw new Error('Fixture missing');
  }
  pilot.downedUntil = 30_000;
  pilot.rescue = { targetId: 'friend', completesAt: 3000 };
  pilot.crewSignal = { kind: 'help', position: { x: 100, y: 0 }, expiresAt: 30_000 };
  rock.supply = { sourceId: 'town-square', value: 1000 };
  world.cooperativeActive = true;
  world.campaign = {
    projectValue: 10_000,
    supplies: [{ id: 'town-square', value: 500 }],
    hives: [],
    cleared: ['frontier:2,0'],
    commissioned: ['frontier:2,0'],
    hazard: { phase: 'warning', kind: 'swarm', startsAt: 1_800_000, endsAt: 1_980_000 },
    meteors: [],
  };
  const decoder = new SnapshotDecoder('diagnostic');
  const first = new SnapshotEncoder(world);
  const read = decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
  expect(read.entities[0]?.downedUntil).toBe(30_000);
  expect(read.asteroids[0]?.supply).toEqual(rock.supply);
  setWorldCampaign(read.cooperativeActive, read.campaign);
  expect(worldFurnaces.isLit('frontier:2,0')).toBe(true);
  pilot.downedUntil = null;
  pilot.rescue = null;
  pilot.crewSignal = null;
  world.campaign.meteors = [{ id: 'meteor', position: { x: 50, y: 50 } }];
  const delta = new SnapshotEncoder(world);
  const next = decodeSnapshotMessage(
    decoder,
    snapshotMessage(delta.encode(2, { sequence: 1, state: first.state }))
  );
  expect(next.entities[0]).toMatchObject({ downedUntil: null, rescue: null, crewSignal: null });
  expect(next.campaign?.meteors).toHaveLength(1);
  setWorldCampaign();
  expect(getWorldCampaign()).toBeUndefined();
  expect(worldFurnaces.isLit('frontier:2,0')).toBe(false);
});

test('local downed snapshots keep the hull visible and an authoritative partial revive restores flight', () => {
  const pilot = new Player({
    id: 'pilot',
    name: 'Pilot',
    type: 'local',
    kitId: 'hauler',
  });
  pilot.updateFromServer({
    health: 0,
    downedUntil: 30_000,
    exploding: false,
    position: { x: 2500, y: 2500 },
  });
  expect(pilot.ship.exploding).toBe(false);
  expect(pilot.ship.health).toBe(0);
  pilot.updateFromServer({
    health: 49,
    downedUntil: null,
    exploding: false,
    spawnProtectionTimer: 120,
    position: { x: 2500, y: 2500 },
  });
  expect(pilot.ship.health).toBe(49);
  expect(pilot.ship.downedUntil).toBeNull();
  expect(pilot.ship.exploding).toBe(false);
});
