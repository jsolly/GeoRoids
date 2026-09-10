import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { KILL_SCORE } from '../../../server/core/combatScoring';
import type { GameEntity } from '../../../server/core/EntityManager';
import { GameEngine } from '../../../server/core/GameEngine';
import { DAMAGE, DEBUG, SHIP } from '../../../src/constants';

function requireBot(bots: GameEntity[] | null, index: number): GameEntity {
  const bot = bots?.[index];
  if (!bot) {
    throw new Error(`Expected configured bot ${index} to exist`);
  }
  return bot;
}

function createBotPair(engine: GameEngine): [GameEntity, GameEntity] {
  const bots = engine.createBots(2);
  return [requireBot(bots, 0), requireBot(bots, 1)];
}

describe('server bot damage and lifecycle scenarios', () => {
  let engine: GameEngine;

  beforeEach(() => {
    engine = new GameEngine(12345);
  });

  afterEach(() => {
    engine.stopGameLoop();
  });

  test('an asteroid hit damages the named bot without touching its bystander', () => {
    const [target, bystander] = createBotPair(engine);
    delete target.spawnProtectionTimer;
    delete bystander.spawnProtectionTimer;
    const targetHealth = target.health;
    const bystanderHealth = bystander.health;

    const destroyed = engine.handleBotDamage(target.id, 'asteroid', DAMAGE.LASER_HIT);

    expect(destroyed).toBe(false);
    expect(target.health).toBe(targetHealth - DAMAGE.LASER_HIT);
    expect(target.exploding).toBe(false);
    expect(bystander.health).toBe(bystanderHealth);
    expect(bystander.exploding).toBe(false);
  });

  test('bot spawn protection follows the configured server policy', () => {
    const [target] = createBotPair(engine);
    const healthBeforeHit = target.health;
    target.spawnProtectionTimer = 1;

    const destroyed = engine.handleBotDamage(target.id, 'asteroid', DAMAGE.LASER_HIT);

    expect(destroyed).toBe(false);
    if (DEBUG.BOT_PLAYER.SPAWN_PROTECTION) {
      expect(target.health).toBe(healthBeforeHit);
    } else {
      expect(target.health).toBe(healthBeforeHit - DAMAGE.LASER_HIT);
    }
  });

  test('lethal overkill clamps health and ignores another hit during explosion', () => {
    const [target] = createBotPair(engine);
    delete target.spawnProtectionTimer;
    const overkill = target.health + 50;

    expect(engine.handleBotDamage(target.id, 'asteroid', overkill)).toBe(true);
    expect(target.health).toBe(0);
    expect(target.exploding).toBe(true);
    expect(target.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES);
    expect(target.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    expect(engine.handleBotDamage(target.id, 'asteroid', DAMAGE.LASER_HIT)).toBe(false);
    expect(target.health).toBe(0);
    expect(target.exploding).toBe(true);
  });

  test('explicit explosion and respawn ticks restore the bot with protection and its anchor', () => {
    const [target] = createBotPair(engine);
    delete target.spawnProtectionTimer;
    expect(engine.handleBotDamage(target.id, 'asteroid', target.health)).toBe(true);

    expect(engine.entityManager.updateExplosions()).toEqual([]);
    expect(target.explodeTime).toBe(SHIP.EXPLODE_DURATION_FRAMES - 1);
    for (let frame = 1; frame < SHIP.EXPLODE_DURATION_FRAMES; frame++) {
      engine.entityManager.updateExplosions();
    }

    expect(target.exploding).toBe(false);
    expect(target.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    expect(engine.entityManager.updateRespawns()).toEqual([]);
    expect(target.respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES - 1);
    for (let frame = 1; frame < SHIP.RESPAWN_DELAY_FRAMES; frame++) {
      engine.entityManager.updateRespawns();
    }

    expect(target.respawnTimer).toBeUndefined();
    expect(target.health).toBe(target.maxHealth);
    expect(target.exploding).toBe(false);
    expect(target.spawnProtectionTimer).toBe(SHIP.INVINCIBILITY_DURATION_FRAMES);
    expect(target.respawnAnchor).toEqual(target.position);
  });

  test('a bot kill credits the named bot attacker and preserves the target life count', () => {
    const [target, attacker] = createBotPair(engine);
    delete target.spawnProtectionTimer;
    delete attacker.spawnProtectionTimer;
    const livesBefore = target.lives;

    expect(engine.handleBotDamage(target.id, attacker.id, target.health)).toBe(true);

    expect(attacker.score).toBe(KILL_SCORE.bot);
    expect(target.lives).toBe(livesBefore);
    expect(target.deathCause).toBe(attacker.id);
  });

  test('missing, zero, and negative bot damage retain their explicit edge behavior', () => {
    expect(engine.handleBotDamage('missing-bot', 'asteroid', DAMAGE.LASER_HIT)).toBe(false);

    const [target] = createBotPair(engine);
    delete target.spawnProtectionTimer;
    const initialHealth = target.health;

    expect(engine.handleBotDamage(target.id, 'asteroid', 0)).toBe(false);
    expect(target.health).toBe(initialHealth);

    expect(engine.handleBotDamage(target.id, 'asteroid', 30)).toBe(false);
    expect(target.health).toBe(initialHealth - 30);
    expect(engine.handleBotDamage(target.id, 'asteroid', -20)).toBe(false);
    expect(target.health).toBe(initialHealth - 10);
  });
});
