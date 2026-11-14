import { expect, test } from 'vitest';
import { FURNACES } from '../../../shared/furnaces';
import type { AsteroidData } from '../../../shared-types';
import { resolveToolFlights } from '../../support/tool-flight';
import { GameServerWorld, useQuietServerConsole } from '../scenarios/support/gameServerWorld';

useQuietServerConsole();

test('furnace intake tells every client the rock was consumed so they play the red smoke poof', () => {
  const world = new GameServerWorld();
  try {
    const hauler = world.join('Hauler', { x: 0, y: 0 }, { kitId: 'hauler' });
    const observer = world.join('Observer', { x: 0, y: 100 });
    world.clearAsteroids();
    const furnace = FURNACES[0];
    if (!furnace) {
      throw new Error('Expected a starter furnace');
    }
    const rock = intakeOre('intake-ore');
    rock.position = { ...furnace.position };
    world.engine.asteroidLifecycle.insert(rock);
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
      data: {},
    });
    expect(actor.harpoonTargetId).toBeNull();
    resolveToolFlights(world.engine);
    expect(actor.harpoonTargetId).toBe(rock.id);
    const scoreBefore = actor.score;
    hauler.socket.clear();
    observer.socket.clear();
    world.engine.advanceCombatFrame();
    expect(world.engine.getAsteroid(rock.id)).toBe(rock);
    expect(actor.score).toBe(scoreBefore);
    world.engine.advanceOneFrame();
    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(actor.harpoonTargetId).toBeNull();
    world.broadcastGameState();
    for (const recipient of [hauler.socket, observer.socket]) {
      expect(
        recipient.inbox
          .map((message) => message.type)
          .filter((type) => ['asteroidDestroy', 'furnaceDelivery', 'snapshot'].includes(type))
      ).toEqual(['asteroidDestroy', 'furnaceDelivery', 'snapshot']);
      expect(recipient.lastReceived('asteroidDestroy')?.data).toEqual({
        asteroidId: rock.id,
        consumedBy: 'furnace',
      });
      expect(recipient.lastReceived('furnaceDelivery')?.data).toMatchObject({
        asteroidId: rock.id,
        furnaceId: furnace.id,
      });
    }
    // The reward reaches the pilot only through snapshot v3 rows.
    const delivered = world.snapshot(hauler).entities.find((entity) => entity.id === hauler.id);
    expect(delivered?.score).toBe(actor.score);
    expect(actor.score - scoreBefore).toBe(300);
    hauler.socket.clear();
    observer.socket.clear();
    world.engine.furnaceDeliveries.advance();
    world.broadcastGameState();
    for (const recipient of [hauler.socket, observer.socket]) {
      expect(recipient.received('asteroidDestroy')).toEqual([]);
      expect(recipient.received('furnaceDelivery')).toEqual([]);
    }
  } finally {
    world.dispose();
  }
});

function intakeOre(id: string): AsteroidData {
  return {
    id,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 25,
    material: 'metal',
    ore: 'metal',
    health: 75,
    maxHealth: 75,
    jaggedness: 0,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
  };
}

test.each(['pause', 'diagnostic', 'reset'] as const)(
  '%s retires pending identified furnace feedback before a later pilot can receive it',
  (transition) => {
    const world = new GameServerWorld();
    try {
      const hauler = world.join('Hauler', { x: 80, y: 0 }, { kitId: 'hauler' });
      const actor = world.entity(hauler);
      world.clearAsteroids();
      for (const id of ['observed-delivery', 'pending-delivery']) {
        const rock = intakeOre(id);
        world.engine.asteroidLifecycle.insert(rock);
        actor.harpoonTargetId = rock.id;
        world.engine.furnaceDeliveries.advance();
        expect(world.engine.getAsteroid(id)).toBeUndefined();
        if (id === 'observed-delivery') {
          expect(world.engine.furnaceDeliveries.drainDeliveries()).toContainEqual(
            expect.objectContaining({ asteroidId: id })
          );
        }
      }
      expect(actor.score).toBe(600);
      switch (transition) {
        case 'pause':
          world.engine.removePlayer(actor.id);
          break;
        case 'diagnostic':
          world.engine.prepareDiagnosticWorld('combat');
          break;
        case 'reset':
          world.engine.resetForTesting();
          break;
        default: {
          const exhaustive: never = transition;
          throw new Error(`Unknown feedback transition: ${exhaustive}`);
        }
      }
      const later = world.join('Later', { x: 0, y: 100 });
      expect(later.socket.received('asteroidDestroy')).toEqual([]);
      expect(later.socket.received('furnaceDelivery')).toEqual([]);
      expect(world.engine.furnaceDeliveries.drainDeliveries()).toEqual([]);
    } finally {
      world.dispose();
    }
  }
);

test('a busy intake keeps every delivery and draining retires all identified feedback once', () => {
  const world = new GameServerWorld();
  try {
    const hauler = world.join('Hauler', { x: 80, y: 0 }, { kitId: 'hauler' });
    const actor = world.entity(hauler);
    world.clearAsteroids();
    const ids = Array.from({ length: 40 }, (_, index) => `busy-intake-${index}`);
    for (const batch of [ids.slice(0, 20), ids.slice(20)]) {
      for (const id of batch) {
        const rock = intakeOre(id);
        rock.boost = { phase: 'burning', ownerId: actor.id, angle: 0 };
        world.engine.asteroidLifecycle.insert(rock);
      }
      world.engine.furnaceDeliveries.advance();
    }
    expect(
      world.engine.furnaceDeliveries.drainDeliveries().map((event) => event.asteroidId)
    ).toEqual(ids);
    expect(actor.score).toBe(40 * 300);
    for (const id of ids) {
      expect(world.engine.getAsteroid(id)).toBeUndefined();
    }
    world.engine.furnaceDeliveries.advance();
    expect(world.engine.furnaceDeliveries.drainDeliveries()).toEqual([]);
    expect(actor.score).toBe(40 * 300);
  } finally {
    world.dispose();
  }
});

test('a due intake consumes the identified collision threat before authoritative combat can kill a nearby pilot', () => {
  const world = new GameServerWorld();
  try {
    const hauler = world.join('Hauler', { x: 80, y: 0 }, { kitId: 'hauler' });
    const actor = world.entity(hauler);
    const nearby = world.join('Nearby Scout', { x: 0, y: 0 }, { kitId: 'scout' });
    const victim = world.entity(nearby);
    world.clearAsteroids();
    world.engine.clearSpiderField();
    victim.health = 1;
    victim.healthRegenTimer = 60;
    victim.spawnProtectionTimer = 0;
    const rock = intakeOre('lethal-if-intake-is-late');
    world.engine.asteroidLifecycle.insert(rock);
    actor.position = { x: 65, y: 0 };
    actor.angle = Math.PI;
    expect(world.engine.useAbility(actor.id)).toBe(true);
    expect(actor.harpoonTargetId).toBeNull();
    expect(actor.utilityFlight?.phase).toBe('outbound');

    world.engine.advanceOneFrame();

    expect(world.engine.getAsteroid(rock.id)).toBeUndefined();
    expect(victim.health).toBe(1);
    expect(victim.exploding).toBe(false);
    expect(actor.score).toBe(300);
    expect(world.engine.furnaceDeliveries.drainDeliveries()).toContainEqual(
      expect.objectContaining({ asteroidId: rock.id })
    );
  } finally {
    world.dispose();
  }
});
