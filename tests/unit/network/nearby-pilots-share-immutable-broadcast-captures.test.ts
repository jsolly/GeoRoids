import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  SnapshotBroadcastCapture,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { nearbyAsteroidRows, WORLD } from '../../../shared/world';
import type { ServerGameSnapshot } from '../../../shared-types';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { RecordingSocket } from '../../support/recordingSocket';
import { snapshotFixture } from './snapshotFixture';

function selected(state: ServerGameSnapshot, center: { x: number; y: number }, scanning = false) {
  const asteroids = nearbyAsteroidRows(state.asteroids, center, scanning);
  return {
    ...state,
    asteroids,
  };
}

function chain(length: number): object {
  let value: object = { leaf: 1 };
  for (let index = 1; index < length; index++) {
    value = { next: value };
  }
  return value;
}

test('overlapping Scout and Hauler broadcasts share captured rocks while retaining private equipment eligibility', () => {
  const engine = new GameEngine(42);
  const broadcaster = new GameStateBroadcaster(engine);
  const scoutSocket = new RecordingSocket();
  const haulerSocket = new RecordingSocket();
  const captures: ReturnType<SnapshotBroadcastCapture['capture']>[] = [];
  const capture = SnapshotBroadcastCapture.prototype.capture;
  vi.spyOn(SnapshotBroadcastCapture.prototype, 'capture').mockImplementation(function (
    this: SnapshotBroadcastCapture,
    state
  ) {
    const result = capture.call(this, state);
    captures.push(result);
    return result;
  });
  try {
    engine.createAsteroids(2, { radius: 500 });
    const scout = engine.addPlayer('capture-scout', 'Scout', scoutSocket, { x: 0, y: 0 }, 'scout');
    const hauler = engine.addPlayer(
      'capture-hauler',
      'Hauler',
      haulerSocket,
      { x: 20, y: 0 },
      'hauler'
    );
    engine.enableAsteroidInteractions(scout);
    engine.enableAsteroidInteractions(hauler);
    broadcaster.negotiateSnapshot(scoutSocket);
    broadcaster.negotiateSnapshot(haulerSocket);
    const probe = engine.dropEquipmentAt({ x: 10, y: 10 }, 'survey_probe');
    const tap = engine.dropEquipmentAt({ x: 10, y: 10 }, 'resource_tap');
    broadcaster.broadcastGameState();
    const scoutRaw = scoutSocket.sent.find((text) => text.startsWith('{"type":"snapshot"'));
    const haulerRaw = haulerSocket.sent.find((text) => text.startsWith('{"type":"snapshot"'));
    assert(scoutRaw && haulerRaw);
    const scoutWorld = decodeSnapshotMessage(new SnapshotDecoder(), scoutRaw);
    const haulerWorld = decodeSnapshotMessage(new SnapshotDecoder(), haulerRaw);
    expect(scoutWorld.loot.map((drop) => drop.id)).toContain(probe.id);
    expect(scoutWorld.loot.map((drop) => drop.id)).not.toContain(tap.id);
    expect(haulerWorld.loot.map((drop) => drop.id)).toContain(tap.id);
    expect(haulerWorld.loot.map((drop) => drop.id)).not.toContain(probe.id);
    const scoutCapture = captures[0];
    const haulerCapture = captures[1];
    assert(scoutCapture && haulerCapture);
    const rock = scoutCapture.asteroids[0];
    assert(rock);
    expect(haulerCapture.asteroids.find((other) => other.id === rock.id)).toBe(rock);
    expect(Object.isFrozen(rock)).toBe(true);
    expect(scoutCapture).not.toBe(haulerCapture);
    expect(scoutCapture.asteroids).not.toBe(haulerCapture.asteroids);
    expect(scoutCapture.loot).not.toBe(haulerCapture.loot);
    expect(scoutCapture.entities[0]).toBe(haulerCapture.entities[0]);
    expect(scoutWorld).toEqual(scoutCapture);
    expect(haulerWorld).toEqual(haulerCapture);
  } finally {
    vi.restoreAllMocks();
    broadcaster.stopPeriodicBroadcast();
    engine.stopGameLoop();
  }
});

test('normal and scanning recipients share only selected frozen rows and match isolated wire frames', () => {
  const world = snapshotFixture();
  world.serverTime = 1000;
  const origin = world.entities[0];
  const near = world.asteroids[0];
  const expanded = world.asteroids[1];
  assert(origin && near && expanded);
  near.position = { ...origin.position };
  expanded.position = {
    x: origin.position.x + WORLD.asteroidInterestRadius + 10,
    y: origin.position.y,
  };
  // An invalid far-away row is never captured by either recipient.
  const distant = Object.assign(
    { ...near, id: 'uncaptured-far-rock', position: { x: 50_000, y: 50_000 } },
    { future: new Date() }
  );
  world.asteroids.push(distant);
  const normal = selected(world, origin.position);
  const scan = selected(world, origin.position, true);
  expect(normal.asteroids.map((rock) => rock.id)).not.toContain(expanded.id);
  expect(scan.asteroids.map((rock) => rock.id)).toContain(expanded.id);
  const context = new SnapshotBroadcastCapture();
  const first = new SnapshotEncoder(normal, context);
  const second = new SnapshotEncoder(scan, context);
  const isolatedNormal = new SnapshotEncoder(normal);
  const isolatedScan = new SnapshotEncoder(scan);
  expect(first.state).toEqual(isolatedNormal.state);
  expect(second.state).toEqual(isolatedScan.state);
  expect(first.state.asteroids.find((rock) => rock.id === near.id)).toBe(
    second.state.asteroids.find((rock) => rock.id === near.id)
  );
  for (const sequence of [1, 9, 90, 999]) {
    expect(first.encodeSerialized(sequence, undefined, 1234)).toEqual(
      isolatedNormal.encodeSerialized(sequence, undefined, 1234)
    );
    expect(
      second.encodeSerialized(sequence, { sequence: sequence - 1, state: first.state }, 1234)
    ).toEqual(
      isolatedScan.encodeSerialized(
        sequence,
        { sequence: sequence - 1, state: isolatedNormal.state },
        1234
      )
    );
  }
});

test('captured rows isolate exact ship anchors and unknown aliases from rounded asteroid vectors', () => {
  const world = snapshotFixture();
  const ship = world.entities[0];
  const rock = world.asteroids[0];
  assert(ship && rock);
  const sharedVector = { x: 1.23456789, y: -2.34567891 };
  ship.position = sharedVector;
  ship.playerMotion = { epoch: 1, mode: 'handoff', ack: 2, anchor: sharedVector };
  rock.position = sharedVector;
  const futureArray = [sharedVector, null, 3];
  delete futureArray[1];
  Object.assign(rock, { future: sharedVector, futureArray, omittedFuture: undefined });
  const context = new SnapshotBroadcastCapture();
  const first = new SnapshotEncoder(world, context);
  const second = new SnapshotEncoder(world, context);
  expect(first.state).toEqual(new SnapshotEncoder(world).state);
  const capturedRock = first.state.asteroids[0];
  const capturedShip = first.state.entities[0];
  assert(capturedRock && capturedShip);
  expect(capturedRock.position).toEqual({ x: 1.2346, y: -2.3457 });
  expect(capturedShip.position).toEqual(sharedVector);
  expect(capturedShip.playerMotion?.anchor).toEqual(sharedVector);
  expect(capturedShip.position).not.toBe(capturedShip.playerMotion?.anchor);
  expect(capturedRock.position).not.toBe(capturedShip.position);
  expect(Object.isFrozen(capturedRock.offsets)).toBe(true);
  expect(Reflect.set(capturedRock.position, 'x', 77)).toBe(false);
  expect(Reflect.set(capturedRock.offsets, '0', 77)).toBe(false);
  expect(second.state.asteroids[0]).toBe(capturedRock);
  expect(first.encodeSerialized(1, undefined, 1).text).toBe(
    second.encodeSerialized(1, undefined, 1).text
  );
  const serialized = first.encodeSerialized(1, undefined, 1).text;
  expect(serialized).toContain('"future":{"x":1.23456789,"y":-2.34567891}');
  expect(serialized).toContain('"futureArray":[{"x":1.23456789,"y":-2.34567891},null,3]');
  expect(serialized).not.toContain('omittedFuture');
});

test('source changes affect the next broadcast while published baselines and same-broadcast rows stay unchanged', () => {
  const world = snapshotFixture();
  const rock = world.asteroids[0];
  assert(rock);
  const context = new SnapshotBroadcastCapture();
  const first = new SnapshotEncoder(world, context);
  const retained = structuredClone(first.state);
  rock.position.x += 100;
  rock.offsets.push(0.23456789);
  world.settlement.resources.ice += 1;
  expect(new SnapshotEncoder(world, context).state).toEqual(retained);
  const next = new SnapshotEncoder(world, new SnapshotBroadcastCapture());
  expect(next.state).toEqual(new SnapshotEncoder(world).state);
  expect(next.state).not.toEqual(retained);
  expect(first.state).toEqual(retained);
  expect(next.state.asteroids[0]).not.toBe(first.state.asteroids[0]);
});

test('failed recipient validation cannot publish stale row captures', () => {
  const world = snapshotFixture();
  const context = new SnapshotBroadcastCapture();
  const rock = world.asteroids[0];
  assert(rock);
  const validHealth = rock.health;
  rock.health = Number.NaN;
  expect(() => new SnapshotEncoder(world, context)).toThrow();
  rock.health = validHealth - 1;
  rock.position.x += 10;
  expect(new SnapshotEncoder(world, context).state).toEqual(new SnapshotEncoder(world).state);
});

test('shared capture preserves nesting limits, unsafe-key checks and non-JSON rejection on cold and warm recipients', () => {
  for (const length of [21, 22]) {
    const world = snapshotFixture();
    const rock = world.asteroids[0];
    assert(rock);
    Object.assign(rock, { future: chain(length) });
    const context = new SnapshotBroadcastCapture();
    if (length === 21) {
      expect(new SnapshotEncoder(world, context).state).toEqual(new SnapshotEncoder(world).state);
      expect(new SnapshotEncoder(world, context).state).toEqual(new SnapshotEncoder(world).state);
    } else {
      expect(() => new SnapshotEncoder(world)).toThrow('nesting');
      expect(() => new SnapshotEncoder(world, context)).toThrow('nesting');
    }
  }
  for (const future of [
    { constructor: 1 },
    new Date(),
    { bad: Number.POSITIVE_INFINITY },
    { bad: undefined, array: [undefined] },
  ]) {
    const world = snapshotFixture();
    const rock = world.asteroids[0];
    assert(rock);
    Object.assign(rock, { future });
    expect(() => new SnapshotEncoder(world)).toThrow();
    expect(() => new SnapshotEncoder(world, new SnapshotBroadcastCapture())).toThrow();
  }
  const valid = snapshotFixture();
  const context = new SnapshotBroadcastCapture();
  expect(new SnapshotEncoder(valid, context).state).toEqual(new SnapshotEncoder(valid).state);
  const invalidUnknownRoot = Object.assign({ ...valid }, { future: { constructor: 1 } });
  expect(() => new SnapshotEncoder(invalidUnknownRoot, context)).toThrow('Unsafe');
});

test('shared canonical captures never repeat rounding at P4 safe53 boundaries or hide sparse known rows', () => {
  const world = snapshotFixture();
  const rock = world.asteroids[0];
  assert(rock);
  rock.position = {
    x: Number.MAX_SAFE_INTEGER / 10_000 - 0.0002,
    y: -(Number.MAX_SAFE_INTEGER / 10_000) + 0.0002,
  };
  rock.velocity = { x: -0, y: 0.000049999999999 };
  rock.rotation = Number.MAX_SAFE_INTEGER / 10_000 - 0.1234;
  const context = new SnapshotBroadcastCapture();
  const isolated = new SnapshotEncoder(world);
  const first = new SnapshotEncoder(world, context);
  const second = new SnapshotEncoder(world, context);
  expect(first.state).toEqual(isolated.state);
  expect(second.encodeSerialized(1, undefined, 0)).toEqual(
    isolated.encodeSerialized(1, undefined, 0)
  );
  expect(first.state.asteroids[0]).toBe(second.state.asteroids[0]);
  expect(Object.is(second.state.asteroids[0]?.velocity.x, -0)).toBe(false);
  const sparse = snapshotFixture();
  delete sparse.asteroids[1];
  expect(() => new SnapshotEncoder(sparse)).toThrow();
  expect(() => new SnapshotEncoder(sparse, new SnapshotBroadcastCapture())).toThrow();
});
