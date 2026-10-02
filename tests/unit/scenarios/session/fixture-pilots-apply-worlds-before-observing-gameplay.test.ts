import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { captureSnapshot, SnapshotEncoder } from '../../../../shared/snapshotProtocol';
import { GameServerWorld } from '../support/gameServerWorld';

test('fixture pilots apply their initial world and keep receiving worlds before an observation', () => {
  const world = new GameServerWorld(72);
  try {
    const pilot = world.join('Pilot');
    world.clearAsteroids();
    const actor = world.entity(pilot);
    for (let index = 1; index <= 12; index++) {
      actor.position.x = index;
      world.broadcastGameState();
    }
    const applied = world.snapshot(pilot);
    expect(applied.entities.find((entity) => entity.id === pilot.id)?.position.x).toBe(12);
    expect(pilot.socket.received('snapshot')).toHaveLength(13);
  } finally {
    world.dispose();
  }
});

test('clearing a fixture recording preserves its applied world and the next delta baseline', () => {
  const world = new GameServerWorld(72);
  try {
    const pilot = world.join('Pilot');
    world.clearAsteroids();
    world.broadcastGameState();
    const before = world.snapshot(pilot);
    pilot.socket.clear();
    expect(world.snapshot(pilot)).toBe(before);
    const actor = world.entity(pilot);
    actor.position.x += 1;
    world.broadcastGameState();
    expect(pilot.socket.lastReceived('snapshot')?.data).toMatchObject({
      sequence: 3,
      kind: 'delta',
      baseline: 2,
    });
    expect(
      world.snapshot(pilot).entities.find((entity) => entity.id === pilot.id)?.position.x
    ).toBe(actor.position.x);
  } finally {
    world.dispose();
  }
});

test('a fixture decode failure earns no receipt and stays separate from transport acceptance', () => {
  const world = new GameServerWorld(72);
  const pilot = world.join('Pilot');
  const acknowledge = vi.spyOn(world.core.getBroadcaster(), 'acknowledgeSnapshot');
  const accepted = vi.fn();
  const frame = new SnapshotEncoder(captureSnapshot(world.snapshot(pilot))).encode(2);
  expect(() => {
    pilot.socket.send(
      JSON.stringify({ type: 'snapshot', data: { ...frame, version: 0 } }),
      accepted
    );
  }).not.toThrow();
  expect(accepted).toHaveBeenCalledOnce();
  expect(accepted.mock.calls[0]).toEqual([]);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(() => world.snapshot(pilot)).toThrow();
  expect(() => world.dispose()).toThrow();
});

test('a decoded fixture world that omits its current pilot earns no application receipt', () => {
  const world = new GameServerWorld(72);
  const pilot = world.join('Pilot');
  const acknowledge = vi.spyOn(world.core.getBroadcaster(), 'acknowledgeSnapshot');
  const state = captureSnapshot(world.snapshot(pilot));
  const owner = state.entities.find((entity) => entity.id === pilot.id);
  assert(owner);
  owner.id = 'different-pilot';
  pilot.socket.send(
    JSON.stringify({ type: 'snapshot', data: new SnapshotEncoder(state).encode(2) })
  );
  expect(acknowledge).not.toHaveBeenCalled();
  expect(() => world.snapshot(pilot)).toThrow('Fixture world omitted its current pilot');
  expect(() => world.dispose()).toThrow('Fixture world omitted its current pilot');
});
