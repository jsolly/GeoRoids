import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GAME, SHIP } from '../../../../src/constants';
import {
  EXPLOSION_FRAMES,
  GameServerWorld,
  type Pilot,
  SPAWN_PROTECTION_FRAMES,
  useQuietServerConsole,
} from '../support/gameServerWorld';

useQuietServerConsole();

describe('Wall or roid hit explodes then respawns without freeze-stick', () => {
  let world: GameServerWorld;
  let ace: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    ace = world.join('Ace');
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('arena wall: flash/explode then respawn+invuln in the explode window', () => {
    const clockAtHit = world.gameTime();
    world.hitBoundary(ace);

    expect(world.entity(ace).health).toBe(0);
    expect(world.entity(ace).exploding).toBe(true);
    expect(world.entity(ace).respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);
    expect(world.entity(ace).lives).toBe(GAME.START_LIVES - 1);

    world.tick(EXPLOSION_FRAMES);

    const ship = world.entity(ace);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
    expect(ship.respawnTimer).toBeUndefined();
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
    expect(world.gameTime() - clockAtHit).toBe(EXPLOSION_FRAMES);
    expect(world.gameTime() - clockAtHit).toBeLessThan(SHIP.INVINCIBILITY_DURATION_FRAMES);
  });

  test('asteroid: same instant-kill path and no multi-second corpse wait', () => {
    world.hitAsteroid(ace, 100);

    expect(world.entity(ace).health).toBe(0);
    expect(world.entity(ace).exploding).toBe(true);
    expect(world.entity(ace).respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    world.tick(EXPLOSION_FRAMES);

    const ship = world.entity(ace);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.respawnTimer).toBeUndefined();
    expect(ship.spawnProtectionTimer).toBeGreaterThan(SPAWN_PROTECTION_FRAMES - 2);
    expect(ship.lives).toBe(GAME.START_LIVES - 1);
  });

  test('player and bot ships share the same respawn schedule', () => {
    let bot = world.engine.getAllBots()[0];
    if (!bot) {
      bot = world.engine.entityManager.createBots(1)[0];
    }
    expect(bot).toBeDefined();
    world.engine.entityManager.updateEntity(bot!.id, { spawnProtectionTimer: 0 });

    world.engine.handleBotDamage(bot!.id, 'asteroid', bot!.health);
    expect(world.ship(bot!.id).respawnTimer).toBe(SHIP.RESPAWN_DELAY_FRAMES);

    world.tick(EXPLOSION_FRAMES);

    const respawned = world.ship(bot!.id);
    expect(respawned.health).toBe(respawned.maxHealth);
    expect(respawned.respawnTimer).toBeUndefined();
    expect(respawned.spawnProtectionTimer).toBeGreaterThan(0);
  });
});
