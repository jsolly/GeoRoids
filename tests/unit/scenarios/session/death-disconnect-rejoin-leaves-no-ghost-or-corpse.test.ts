import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE } from '../../../../src/constants';
import { RecordingSocket } from '../../../support/recordingSocket';
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

  test('rejoining the same id mid-explosion comes back alive with spawn protection', () => {
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

    const socket = new RecordingSocket();
    world.send(
      { id: ace.id, name: ace.name, socket },
      {
        type: 'join',
        id: ace.id,
        name: ace.name,
        data: { name: ace.name, position: { x: 0, y: 0 } },
      }
    );

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

  test('a new tab with the same name mid-death takes over a live ship and tells peers the old id left', () => {
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
    const clone = world.join('Ace', { x: 40, y: 0 });

    expect(world.engine.getPlayer(ace.id)).toBeUndefined();
    const ship = world.engine.getPlayer(clone.id);
    expect(ship?.health).toBe(ship?.maxHealth);
    expect(ship?.exploding).toBe(false);
    expect(ship?.respawnTimer).toBeUndefined();
    expect(world.engine.getPlayerCount()).toBe(2);
    expect(bo.socket.lastReceived('playerLeft')?.data).toMatchObject({ id: ace.id });
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
    world.disconnect(ace);

    const socket = new RecordingSocket();
    world.send(
      { id: ace.id, name: ace.name, socket },
      {
        type: 'join',
        id: ace.id,
        name: ace.name,
        data: { name: ace.name, position: { x: 0, y: 0 } },
      }
    );

    const ship = world.entity(ace);
    expect(ship.lives).toBe(livesAfterDeath);
    expect(ship.health).toBe(ship.maxHealth);
    expect(ship.exploding).toBe(false);
    expect(ship.spawnProtectionTimer).toBeGreaterThan(0);
    expect(world.leaderboardNames()).toEqual(expect.arrayContaining(['Ace', 'Bo']));
  });
});
