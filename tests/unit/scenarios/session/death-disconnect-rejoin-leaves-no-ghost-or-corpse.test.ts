import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE } from '../../../../src/constants';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('Death, disconnect, and rejoin leave no corpse or ghost', () => {
  let world: GameServerWorld;
  let ace: Pilot;
  let bo: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    ace = world.join('Ace');
    bo = world.join('Bo', { x: 80, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('resuming after a death keeps the authoritative respawn lifecycle', () => {
    world.send(ace, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: ace.id,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
    expect(world.entity(ace).exploding).toBe(true);
    expect(world.entity(ace).health).toBe(0);

    world.tickThroughRespawn();
    ace = world.resume(ace);

    const ship = world.entity(ace);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
    expect(ship.respawnTimer).toBeUndefined();
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
    expect(ship.velocity).toEqual({ x: 0, y: 0 });
    expect(world.engine.getPlayerCount()).toBe(2);
  });

  test('disconnect after death removes the corpse so the peer is not left with a ghost', () => {
    world.send(ace, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: ace.id,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
    expect(world.entity(ace).health).toBe(0);

    bo.socket.clear();
    world.disconnect(ace);

    expect(world.isOnServer(ace)).toBe(false);
    expect(world.leaderboardNames()).not.toContain('Ace');
    expect(bo.socket.lastReceived('playerLeft')?.data).toMatchObject({ id: ace.id });
    expect(world.isOnServer(bo)).toBe(true);
  });

  test('a new tab with the same name cannot take over without the private resume token', () => {
    world.send(ace, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: ace.id,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
    expect(world.entity(ace).exploding).toBe(true);

    bo.socket.clear();
    const cloneSocket = world.attemptJoin('ace-clone', 'Ace', { x: 40, y: 0 });

    expect(cloneSocket.received('joined')).toHaveLength(0);
    expect(cloneSocket.received('error')).toHaveLength(1);
    expect(world.engine.getPlayer(ace.id)).toBeDefined();
    expect(world.engine.getPlayerCount()).toBe(2);
    expect(bo.socket.received('playerLeft')).toHaveLength(0);
  });

  test('drop then rejoin after death is a live ship, not a frozen hull', () => {
    world.send(ace, {
      type: 'collisionDamage',
      data: {
        targetPlayerId: ace.id,
        attackerId: 'boundary',
        damage: DAMAGE.BOUNDARY_COLLISION,
      },
    });
    const livesAfterDeath = world.entity(ace).lives;
    world.dropTransport(ace);
    world.tickThroughRespawn();
    ace = world.resume(ace);

    const ship = world.entity(ace);
    expect(ship.lives).toBe(livesAfterDeath);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
    expect(world.leaderboardNames()).toEqual(expect.arrayContaining(['Ace', 'Bo']));
  });
});
