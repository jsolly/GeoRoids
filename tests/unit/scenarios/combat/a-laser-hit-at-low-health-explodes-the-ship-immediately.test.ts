import assert from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { DAMAGE, GAME, SHIP } from '../../../../src/constants';
import { Ship } from '../../../../src/entities/ship/Ship';
import {
  EXPLOSION_FRAMES,
  GameServerWorld,
  SPAWN_PROTECTION_FRAMES,
  useQuietServerConsole,
} from '../support/gameServerWorld';
import { SHIP_KINDS } from '../support/shipKinds';

useQuietServerConsole();

const LOW_HEALTH = DAMAGE.LASER_HIT - 5;

describe.each(SHIP_KINDS)('A laser hits a $kind', ({ options }) => {
  test('at full health it survives and loses one laser hit of health', () => {
    const ship = new Ship(options);
    ship.takeDamage(DAMAGE.LASER_HIT, 'laser');

    expect(ship.health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(ship.exploding).toBe(false);
  });

  test('at low health it explodes on the very same frame, with the cause attached', () => {
    const ship = new Ship(options);
    ship.health = LOW_HEALTH;
    const explosions: string[] = [];
    window.addEventListener(
      'shipExploded',
      (event) => {
        explosions.push((event as CustomEvent<{ cause?: string }>).detail.cause ?? '');
      },
      { once: true }
    );

    ship.takeDamage(DAMAGE.LASER_HIT, 'Bob');

    expect(ship.health).toBe(0);
    expect(ship.exploding).toBe(true);
    expect(explosions).toEqual(['Bob']);
  });

  test('an exploding ship cannot be hit again, and the explosion resolves in 0.3s', () => {
    const ship = new Ship(options);
    ship.health = LOW_HEALTH;
    ship.takeDamage(DAMAGE.LASER_HIT);
    ship.takeDamage(DAMAGE.LASER_HIT);

    expect(ship.health).toBe(0);
    for (let frame = 0; frame < EXPLOSION_FRAMES; frame++) {
      ship.update();
    }
    expect(ship.explodeTime).toBe(0);
    expect(ship.exploding).toBe(true);
    expect(EXPLOSION_FRAMES / GAME.FPS).toBeCloseTo(0.3);
  });
});

describe('Server view: the killing shot', () => {
  test('destroys the target, costs a life, and tells the attacker in one go', () => {
    const world = new GameServerWorld();
    const alice = world.join('Alice');
    const bob = world.join('Bob');
    world.tick(SPAWN_PROTECTION_FRAMES);

    world.shoot(alice, bob);
    world.shoot(alice, bob);
    world.shoot(alice, bob);
    expect(world.entity(bob).health).toBe(DAMAGE.LASER_HIT);

    alice.socket.clear();
    world.shoot(alice, bob);

    expect(world.entity(bob).health).toBe(0);
    expect(world.entity(bob).exploding).toBe(true);
    expect(world.entity(bob).lives).toBe(GAME.START_LIVES - 1);
    expect(alice.socket.lastReceived('playerDamaged')?.data).toMatchObject({
      targetPlayerId: bob.id,
      remainingHealth: 0,
      isDestroyed: true,
      remainingLives: GAME.START_LIVES - 1,
    });
    expect(alice.socket.lastReceived('playerKilled')?.data).toMatchObject({
      targetPlayerName: 'Bob',
      attackerId: alice.id,
    });

    world.dispose();
  });

  test('a bot ship also explodes immediately when a laser finishes it', () => {
    const world = new GameServerWorld();
    const alice = world.join('Alice');
    const bots = world.engine.createBots(1);
    assert.ok(bots);
    const bot = bots[0];
    assert.ok(bot);
    bot.health = LOW_HEALTH;

    world.shootBot(alice, bot.id);

    expect(world.ship(bot.id).health).toBe(0);
    expect(world.ship(bot.id).exploding).toBe(true);

    world.dispose();
  });
});
