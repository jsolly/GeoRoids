import { expect, test } from 'vitest';
import { FURNACES } from '../../../shared/furnaces';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

test('furnace intake tells every client the rock was consumed so they play the red smoke poof', () => {
  const world = new GameServerWorld();
  try {
    const hauler = world.join('Hauler', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
    const furnace = FURNACES[0];
    if (!furnace) {
      throw new Error('Expected a starter furnace');
    }
    const rock = {
      id: 'intake-ore',
      position: { ...furnace.position },
      velocity: { x: 0, y: 0 },
      size: 25,
      jaggedness: 0,
      rotation: 0,
      angularVelocity: 0,
      health: 75,
      maxHealth: 75,
      vertices: 4,
      offsets: [1, 1, 1, 1],
      material: 'metal' as const,
    };
    world.engine.addAsteroid(rock);
    world.send(hauler, {
      type: 'setHaulerUtility',
      id: hauler.id,
      data: { utilityId: 'tow_cable' },
    });
    const actor = world.entity(hauler);
    actor.position = { x: furnace.position.x + 80, y: furnace.position.y };
    actor.angle = Math.PI;
    world.send(hauler, {
      type: 'useAbility',
      id: hauler.id,
      data: { kitId: 'hauler', abilityId: 'harpoon' },
    });
    expect(actor.harpoonTargetId).toBe(rock.id);
    hauler.socket.clear();
    world.engine.processFurnaceDeliveries();
    world.broadcastGameState();
    expect(hauler.socket.lastReceived('asteroidDestroy')?.data).toEqual({
      asteroidId: rock.id,
      collabSplit: false,
      consumedBy: 'furnace',
    });
    expect(hauler.socket.lastReceived('furnaceDelivery')?.data).toMatchObject({
      asteroidId: rock.id,
      furnaceId: furnace.id,
    });
  } finally {
    world.dispose();
  }
});
