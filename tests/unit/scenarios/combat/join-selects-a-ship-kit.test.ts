import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SHIP } from '../../../../src/constants';
import { getShipKit } from '../../../../src/entities/ship/shipKits';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('A pilot joins with a chosen ship kit', () => {
  let world: GameServerWorld;
  let alice: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
  });

  afterEach(() => {
    world.dispose();
  });

  test('the default kit is Dart with classic health', () => {
    alice = world.join('Alice');
    expect(world.entity(alice).kitId).toBe('dart');
    expect(world.entity(alice).maxHealth).toBe(SHIP.MAX_HEALTH);
    expect(world.entity(alice).health).toBe(SHIP.MAX_HEALTH);
  });

  test('joining as Warden applies Warden health', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'warden' });
    const warden = getShipKit('warden');
    expect(world.entity(alice).kitId).toBe('warden');
    expect(world.entity(alice).maxHealth).toBe(warden.maxHealth);
    expect(world.entity(alice).health).toBe(warden.maxHealth);
  });

  test('join assigns a soft side without changing the chosen kit', () => {
    alice = world.join('Alice', { x: 0, y: 0 }, { kitId: 'skirmisher' });
    expect(world.entity(alice).kitId).toBe('skirmisher');
    expect(
      world.entity(alice).factionId === 'ion' || world.entity(alice).factionId === 'ember'
    ).toBe(true);
  });
});
