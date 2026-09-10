import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE, SHIP } from '../../../../src/constants';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A player can shoot another player', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: -40, y: 0 });
    bob = world.join('Bob', { x: 40, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('the other player loses one laser hit of health', () => {
    world.shoot(alice, bob);

    expect(world.entity(bob).health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
    expect(world.entity(bob).exploding).toBe(false);
    expect(world.entity(alice).health).toBe(SHIP.MAX_HEALTH);
  });

  test('both pilots see the same health drop on that shot', () => {
    world.shoot(alice, bob);

    for (const socket of [alice.socket, bob.socket]) {
      expect(socket.lastReceived('playerDamaged')?.data).toMatchObject({
        targetPlayerId: bob.id,
        attackerId: alice.id,
        remainingHealth: SHIP.MAX_HEALTH - DAMAGE.LASER_HIT,
        isDestroyed: false,
      });
    }

    world.broadcastGameState();
    for (const pilot of [alice, bob]) {
      expect(world.snapshot(pilot).entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: bob.id, health: SHIP.MAX_HEALTH - DAMAGE.LASER_HIT }),
        ])
      );
    }
  });
});
