import { afterEach, beforeEach, expect, test } from 'vitest';
import { GameEngine } from '../../../../server/core/GameEngine';
import type { AsteroidData } from '../../../../shared-types';
import { DAMAGE, SHIP } from '../../../../src/constants';

let engine: GameEngine;

beforeEach(() => {
  engine = new GameEngine(12345);
});

afterEach(() => {
  engine.stopGameLoop();
});

function rock(id: string, position: { x: number; y: number }): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size: 25,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
}

test('two bots ram separate asteroids in the same tick without duplicate damage', () => {
  const bots = engine.createBots(2);
  if (bots?.length !== 2) {
    throw new Error('The collision fixture requires exactly two bots');
  }
  const initialHealth = bots.map((bot) => bot.health);
  for (const [index, bot] of bots.entries()) {
    const position = { x: index * 500, y: 0 };
    engine.entityManager.updateEntity(bot.id, { position, spawnProtectionTimer: 0 });
    engine.addAsteroid(rock(`impact-${index}`, position));
  }

  const impacts = engine.resolveAuthoritativeCombat(1000);

  expect(impacts).toHaveLength(2);
  expect(impacts.every((impact) => impact.attackerId === 'asteroid')).toBe(true);
  const damagedHealth = initialHealth.map((health) => health - DAMAGE.LASER_HIT);
  expect(bots.map((bot) => bot.health)).toEqual(damagedHealth);
  for (const index of bots.keys()) {
    expect(engine.getAsteroid(`impact-${index}`)).toBeUndefined();
  }
  expect(engine.resolveAuthoritativeCombat(1050)).toHaveLength(0);
  expect(bots.map((bot) => bot.health)).toEqual(damagedHealth);
});

test('a weakened bot killed by an asteroid respawns at full health after the respawn delay', () => {
  const bot = engine.createBots(2)?.[0];
  if (!bot) {
    throw new Error('The respawn fixture requires a bot');
  }
  const impactPosition = { x: 2000, y: 0 };
  engine.entityManager.updateEntity(bot.id, {
    position: impactPosition,
    health: DAMAGE.LASER_HIT,
    spawnProtectionTimer: 0,
  });
  engine.addAsteroid(rock('fatal-impact', impactPosition));

  const impacts = engine.resolveAuthoritativeCombat(1000);

  expect(impacts).toHaveLength(1);
  expect(impacts[0]?.attackerId).toBe('asteroid');
  expect(bot.health).toBe(0);
  expect(bot.exploding).toBe(true);
  expect(engine.getAsteroid('fatal-impact')).toBeUndefined();
  for (let frame = 0; frame < SHIP.RESPAWN_DELAY_FRAMES - 1; frame++) {
    engine.entityManager.updateExplosions();
    engine.entityManager.updateRespawns();
  }
  expect(bot.health).toBe(0);
  engine.entityManager.updateExplosions();
  expect(engine.entityManager.updateRespawns()).toContain(bot.id);
  expect(bot.exploding).toBe(false);
  expect(bot.health).toBe(bot.maxHealth);
  expect(bot.position).not.toEqual(impactPosition);
  expect(bot.respawnTimer).toBeUndefined();
});
