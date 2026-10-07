/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test } from 'vitest';
import { readServerConfiguration } from '../../../server/configuration';
import { GameEngine } from '../../../server/core/GameEngine';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { EQUIPMENT_IDS } from '../../../shared/equipment';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { RecordingSocket } from '../../support/recordingSocket';

test('local pilots start with points, nearby tools and hulls, and three lit travel destinations', () => {
  const engine = new GameEngine(42, undefined, undefined, true);
  const pilot = engine.addPlayer('local', 'Local', new RecordingSocket());
  expect(pilot.score).toBe(5_000);
  expect(
    engine
      .getLoot()
      .map((drop) => drop.kind)
      .sort((a, b) => a.localeCompare(b))
  ).toEqual([...EQUIPMENT_IDS].sort((a, b) => a.localeCompare(b)));
  const hulls = engine.getAllSatellitePickups();
  expect(hulls).toHaveLength(6);
  expect(new Set(hulls.map((hull) => hull.typeId)).size).toBe(6);
  for (const pickup of [...engine.getLoot(), ...hulls]) {
    expect(
      Math.hypot(
        pickup.position.x - TOWN_HEARTH.position.x,
        pickup.position.y - TOWN_HEARTH.position.y
      )
    ).toBeLessThan(700);
  }
  const destinations = CIVIC_LOTS.filter((lot) => lot.parentId === TOWN_HEARTH.id);
  expect(destinations.filter((lot) => engine.isFurnaceLit(lot.id))).toHaveLength(3);
});

test('ordinary fixtures retain their normal starting balance and unbuilt destinations', () => {
  const engine = new GameEngine(42);
  expect(engine.addPlayer('normal', 'Normal', new RecordingSocket()).score).toBe(0);
  expect(engine.getLoot()).toHaveLength(0);
  expect(CIVIC_LOTS.filter((lot) => engine.isFurnaceLit(lot.id))).toHaveLength(0);
});

test('production and unconfigured development servers reject the local preset', () => {
  expect(
    readServerConfiguration({ NODE_ENV: 'production', GEOROIDS_LOCAL_PLAYGROUND: '1' })
      .localPlayground
  ).toBe(false);
  expect(readServerConfiguration({ NODE_ENV: 'development' }).localPlayground).toBe(false);
  expect(
    readServerConfiguration({ NODE_ENV: 'development', GEOROIDS_LOCAL_PLAYGROUND: '0' })
      .localPlayground
  ).toBe(false);
  expect(
    readServerConfiguration({ NODE_ENV: 'development', GEOROIDS_LOCAL_PLAYGROUND: '1' })
      .localPlayground
  ).toBe(true);
});

test('a local restart preserves builder ownership and larger balances while live reconnects retain spent points', () => {
  const store = new WorldStore(':memory:');
  try {
    const first = new GameEngine(42, undefined, new InlineWorldPersistence(store));
    const lot = CIVIC_LOTS.find((candidate) => candidate.parentId === TOWN_HEARTH.id);
    assert(lot);
    const scoutSocket = new RecordingSocket();
    const scout = first.addPlayer('builder', 'Ada', scoutSocket, lot.position, 'scout');
    scout.position = { ...lot.position };
    scout.score = lot.cost + 200;
    scout.asteroidInteractions = 1;
    expect(first.useAbility(scout.id)).toBe(true);
    const low = first.registerPilot(scout, scoutSocket);
    assert(low.ok);
    const richSocket = new RecordingSocket();
    const rich = first.addPlayer('rich', 'Rich', richSocket);
    rich.score = 9_000;
    rich.asteroidInteractions = 1;
    const high = first.registerPilot(rich, richSocket);
    assert(high.ok);
    first.removePlayer(scout.id);
    first.removePlayer(rich.id);
    first.stopGameLoop();
    const restored = new GameEngine(99, undefined, new InlineWorldPersistence(store), true);
    expect(restored.getGameState().civicModules).toContainEqual({
      id: lot.id,
      builderName: 'Ada',
      builderId: 'builder',
    });
    const lowResume = restored.resumePilot(low.resumeToken, new RecordingSocket());
    const highResume = restored.resumePilot(high.resumeToken, new RecordingSocket());
    assert(lowResume.ok && highResume.ok);
    expect(lowResume.actor.score).toBe(5_000);
    expect(highResume.actor.score).toBe(9_000);
    lowResume.actor.score = 300;
    const live = restored.resumePilot(lowResume.resumeToken, new RecordingSocket());
    assert(live.ok);
    expect(live.actor).toBe(lowResume.actor);
    expect(live.actor.score).toBe(300);
    restored.stopGameLoop();
  } finally {
    store.close();
  }
});
