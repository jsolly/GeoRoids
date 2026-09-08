import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

describe('Both ships move independently after join', () => {
  let world: GameServerWorld;
  let alice: Pilot;
  let bob: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    alice = world.join('Alice', { x: 0, y: 0 });
    bob = world.join('Bob', { x: 0, y: 0 });
    world.wearOffJoinInvulnerability();
  });

  afterEach(() => {
    world.dispose();
  });

  test('each pilot can sit in a different place without dragging the other', () => {
    world.move(alice, { x: -200, y: 50 });
    world.move(bob, { x: 200, y: -50 });

    expect(world.entity(alice).position).toEqual({ x: -200, y: 50 });
    expect(world.entity(bob).position).toEqual({ x: 200, y: -50 });
  });
});
