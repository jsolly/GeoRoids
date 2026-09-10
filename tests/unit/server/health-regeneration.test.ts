/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../../shared/constants/health';
import { DAMAGE, GAME, SHIP } from '../../../src/constants';
import { GameServerWorld, type Pilot } from '../scenarios/support/gameServerWorld';

describe('server-authoritative health regeneration', () => {
  let world: GameServerWorld;
  let pilot: Pilot;

  beforeEach(() => {
    world = new GameServerWorld(90210);
    pilot = world.join('Pilot', { x: 0, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('uses the ship tuning for one-frame rate and post-damage delay', () => {
    expect(calculateHealthRegenPerFrame()).toBe(SHIP.HEALTH_REGEN_RATE / GAME.FPS);
    expect(calculateHealthRegenDelayFrames()).toBe(Math.ceil(SHIP.HEALTH_REGEN_DELAY * GAME.FPS));
  });

  test('human damage waits for the delay, then heals and caps at max health', () => {
    const ship = world.entity(pilot);
    world.engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    expect(ship.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    world.tick(calculateHealthRegenDelayFrames());
    expect(ship.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);

    world.tick(1);
    expect(ship.health).toBeCloseTo(
      SHIP.MAX_HEALTH - DAMAGE.LASER_HIT + calculateHealthRegenPerFrame()
    );

    ship.health = ship.maxHealth - calculateHealthRegenPerFrame() / 2;
    ship.healthRegenTimer = 0;
    world.tick(1);
    expect(ship.health).toBe(ship.maxHealth);
  });

  test('a repeated hit resets the same regeneration timer', () => {
    const ship = world.entity(pilot);
    world.engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    world.tick(calculateHealthRegenDelayFrames() - 1);
    const healthBeforeSecondHit = ship.health;

    world.engine.handlePlayerDamage(pilot.id, 'asteroid', 1);
    expect(ship.health).toBe(healthBeforeSecondHit - 1);
    expect(ship.healthRegenTimer).toBe(calculateHealthRegenDelayFrames());

    world.tick(calculateHealthRegenDelayFrames());
    expect(ship.health).toBe(healthBeforeSecondHit - 1);
    world.tick(1);
    expect(ship.health).toBeCloseTo(healthBeforeSecondHit - 1 + calculateHealthRegenPerFrame());
  });

  test('a client update cannot clear the server timer and a last-life ship stays dead', () => {
    const ship = world.entity(pilot);
    world.engine.handlePlayerDamage(pilot.id, 'asteroid', DAMAGE.LASER_HIT);
    const delay = ship.healthRegenTimer;

    world.send(pilot, {
      type: 'update',
      id: pilot.id,
      data: { healthRegenTimer: 0 },
    });
    expect(ship.healthRegenTimer).toBe(delay);

    ship.lives = 0;
    world.engine.handlePlayerDamage(pilot.id, 'asteroid', ship.health);
    expect(ship.health).toBe(0);
    world.tick(SHIP.EXPLODE_DURATION_FRAMES + SHIP.RESPAWN_DELAY_FRAMES + 1);
    expect(ship.health).toBe(0);
    expect(ship.respawnTimer).toBeUndefined();
  });

  test('bots use the same delay and rate as humans', () => {
    const bot = world.engine.createBots(1)?.[0];
    assert.ok(bot, 'Expected the newly created bot');
    delete bot.spawnProtectionTimer;
    world.engine.handleBotDamage(bot.id, 'asteroid', DAMAGE.LASER_HIT);
    const damagedHealth = bot.health;

    world.tick(calculateHealthRegenDelayFrames());
    expect(bot.health).toBe(damagedHealth);

    world.tick(1);
    expect(bot.health).toBeCloseTo(damagedHealth + calculateHealthRegenPerFrame());
  });
});
