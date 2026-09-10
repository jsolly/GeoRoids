import { afterEach, assert, beforeEach, describe, expect, test } from 'vitest';
import type { WebSocket } from 'ws';
import { GameEngine } from '../../../server/core/GameEngine';
import { isFuelLoot } from '../../../shared/fuel';
import type { AsteroidData } from '../../../shared-types';
import { FUEL, ROID } from '../../../src/constants';

function makeAsteroid(id: string, size: number): AsteroidData {
  return {
    id,
    position: { x: 100, y: 80 },
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

describe('server fuel pickup and EMP spend', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(99);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('game state snapshots include fuel tanks and live fuel drops', () => {
    const ws = {} as WebSocket;
    const human = engine.addPlayer('human-state', 'Pilot', ws, { x: 0, y: 0 }, undefined, 'quake');
    engine.addAsteroid(makeAsteroid('roid-state', ROID.SIZE));
    engine.handleAsteroidHit('roid-state', human.id, 'collision');

    const state = engine.getGameState();
    const snapshot = state.entities.find((entity) => entity.id === human.id);
    expect(snapshot?.fuel).toBe(FUEL.START);
    expect(snapshot?.maxFuel).toBe(FUEL.MAX);
    expect(state.loot.filter(isFuelLoot)).toHaveLength(1);
  });

  test('Quake EMP spend is refused once the shared tank is empty', () => {
    const ws = {} as WebSocket;
    const quake = engine.addPlayer('human-emp', 'Quake', ws, { x: 0, y: 0 }, undefined, 'quake');
    const dart = engine.addPlayer('human-dart', 'Dart', ws, { x: 20, y: 0 }, undefined, 'dart');

    expect(engine.useAbility(quake.id)).toBe(true);
    expect(quake.fuel).toBe(FUEL.START - FUEL.EMP_COST);
    expect(engine.useAbility(dart.id)).toBe(true);
    expect(dart.fuel).toBe(FUEL.START);

    quake.fuel = 0;
    quake.abilityCooldownFrames = 0;
    expect(engine.useAbility(quake.id)).toBe(false);
    expect(quake.fuel).toBe(0);
  });

  test('shooting a fuel drop uses the destroy-drop blast path', () => {
    const ws = {} as WebSocket;
    const human = engine.addPlayer('human-blast', 'Pilot', ws, { x: 80, y: 80 });
    engine.addAsteroid(makeAsteroid('roid-blast', ROID.SIZE));
    engine.handleAsteroidHit('roid-blast', human.id, 'collision');
    const fuel = engine.getLoot().find(isFuelLoot);
    assert.exists(fuel);

    const blast = engine.handleLootExplode(human.id, fuel.id);

    expect(blast.success).toBe(true);
    expect(engine.getLoot().some(isFuelLoot)).toBe(false);
  });

  test('game state snapshots stay JSON-safe when the player socket holds a Timeout', () => {
    const idle: { _idleNext: unknown; _idlePrev: unknown } = { _idleNext: null, _idlePrev: null };
    idle._idleNext = idle;
    idle._idlePrev = idle;
    const timeout = { constructor: { name: 'Timeout' }, _idlePrev: idle, _idleNext: idle };
    const ws = Object.assign({} as WebSocket, { _closeTimeout: timeout });
    engine.addPlayer('human-ws', 'Pilot', ws, { x: 0, y: 0 }, undefined, 'hauler');
    const live = engine.getPlayer('human-ws');
    expect(() => JSON.stringify({ ...live })).toThrow(/circular/i);

    const state = engine.getGameState();
    expect(() => JSON.stringify(state)).not.toThrow();
    const snapshot = state.entities.find((entity) => entity.id === 'human-ws') as
      | { ws?: unknown; fuel?: number }
      | undefined;
    expect(snapshot?.ws).toBeUndefined();
    expect(snapshot?.fuel).toBe(FUEL.START);
  });

  test('client updates cannot set fuel on the server tank', () => {
    const ws = {} as WebSocket;
    const human = engine.addPlayer('human-auth', 'Pilot', ws, { x: 0, y: 0 });
    engine.updatePlayer(human.id, { fuel: 99, maxFuel: 200 } as Partial<typeof human>);
    expect(human.fuel).toBe(FUEL.START);
    expect(human.maxFuel).toBe(FUEL.MAX);
  });
});
