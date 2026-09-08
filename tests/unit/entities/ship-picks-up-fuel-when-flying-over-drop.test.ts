import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { applyFuelPickup, applyFuelSnapshot, isFuelLoot } from '../../../shared/fuel';
import type { AsteroidData } from '../../../shared-types';
import { FUEL, ROID } from '../../../src/constants';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

function makeAsteroid(id: string, size: number, position = { x: 100, y: 80 }): AsteroidData {
  return {
    id,
    position,
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

describe('ship picks up fuel when flying over a drop', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(77);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('local and bot ships fill from the same server overlap path', () => {
    const ws = {} as any;
    const human = engine.addPlayer('human-1', 'Pilot', ws, { x: 0, y: 0 });
    const bots = engine.createBots(1);
    expect(bots && bots[0]).toBeTruthy();
    const bot = bots![0]!;
    for (const extra of bots ?? []) {
      if (extra.id !== bot.id) {
        engine.updatePlayer(extra.id, { position: { x: -800, y: -800 } });
      }
    }

    engine.addAsteroid(makeAsteroid('roid-a', ROID.SIZE, { x: 10, y: 10 }));
    engine.addAsteroid(makeAsteroid('roid-b', ROID.SIZE, { x: 200, y: 10 }));
    engine.handleAsteroidHit('roid-a', human.id, 'collision');
    engine.handleAsteroidHit('roid-b', bot.id, 'collision');

    const drops = engine.getLoot().filter(isFuelLoot);
    expect(drops).toHaveLength(2);
    engine.updatePlayer(human.id, { position: { ...drops[0]!.position } });
    engine.updatePlayer(bot.id, { position: { ...drops[1]!.position } });

    const collected = engine.collectLoot();
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(human.fuel).toBe(FUEL.START + FUEL.DROP_AMOUNT);
    expect(bot.fuel).toBe(FUEL.START + FUEL.DROP_AMOUNT);
    expect(engine.getLoot().some(isFuelLoot)).toBe(false);
  });

  test('a full tank leaves the fuel drop in the world', () => {
    const ws = {} as any;
    const human = engine.addPlayer('human-full', 'Pilot', ws, { x: 0, y: 0 });
    human.fuel = FUEL.MAX;
    engine.addAsteroid(makeAsteroid('roid-full', ROID.SIZE, { x: 0, y: 0 }));
    engine.handleAsteroidHit('roid-full', human.id, 'collision');
    const drop = engine.getLoot().find(isFuelLoot);
    expect(drop).toBeDefined();
    engine.updatePlayer(human.id, { position: { ...drop!.position } });

    const collected = engine.collectLoot();
    expect(collected.every((item) => item.lootId !== drop!.id)).toBe(true);
    expect(human.fuel).toBe(FUEL.MAX);
    expect(engine.getLoot().some((item) => item.id === drop!.id)).toBe(true);
  });

  test('pickup caps at the shared max tank', () => {
    const tank = { fuel: 90, maxFuel: FUEL.MAX };
    expect(applyFuelPickup(tank, FUEL.DROP_AMOUNT)).toBe(FUEL.MAX);
  });

  test('a stale server echo does not rewind a fresh EMP spend', () => {
    const player = new Player({
      id: 'local-player-123',
      name: 'Pilot',
      type: 'local',
      input: new MockPlayerInput(),
    });
    player.ship.fuel = 50;
    player.ship.lastLocalFuelWriteMs = Date.now();
    player.ship.fuel = 25;
    applyFuelSnapshot(player.ship, { fuel: 50 });
    expect(player.ship.fuel).toBe(25);
  });
});
