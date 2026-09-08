import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DAMAGE, SHIP } from '../../../../src/constants';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('Soft-faction compose leaves same-side shots harmless', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  test('auto-balanced opposite sides still take laser damage', () => {
    alice = world.join('Alice', { x: -80, y: 0 });
    bob = world.join('Bob', { x: 80, y: 0 });
    world.wearOffJoinInvulnerability();
    world.shoot(alice, bob);
    expect(world.entity(bob).health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
  });

  test('same-side pilots do not damage each other once sides are set', () => {
    alice = world.join('Alice', { x: -80, y: 0 }, { factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { factionId: 'ion' });
    world.wearOffJoinInvulnerability();
    world.shoot(alice, bob);
    expect(world.entity(bob).health).toBe(SHIP.MAX_HEALTH);
    expect(world.entity(bob).exploding).toBe(false);
  });

  test('opposite sides still take laser damage', () => {
    alice = world.join('Alice', { x: -80, y: 0 }, { factionId: 'ion' });
    bob = world.join('Bob', { x: 80, y: 0 }, { factionId: 'ember' });
    world.wearOffJoinInvulnerability();
    world.shoot(alice, bob);
    expect(world.entity(bob).health).toBe(SHIP.MAX_HEALTH - DAMAGE.LASER_HIT);
  });
});
