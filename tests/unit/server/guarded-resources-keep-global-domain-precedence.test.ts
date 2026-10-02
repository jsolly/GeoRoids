/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { expect, test, vi } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { LootManager } from '../../../server/core/LootManager';
import { InlineWorldPersistence } from '../../../server/world/InlineWorldPersistence';
import { WorldStore } from '../../../server/world/WorldStore';
import { emptySettlement } from '../../../shared/economy';
import { WORLD } from '../../../shared/world';
import { RecordingSocket } from '../../support/recordingSocket';

test.each(['loot', 'pickup', 'pickup-over-loot'] as const)(
  'a distant eligible %s takes precedence over a nearby asteroid with the same ID',
  (domain) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = new WorldStore(':memory:');
    store.checkpoint(
      { seed: 82, startedAt: 1, generation: WORLD.generation, exploration: [] },
      new Map(),
      [],
      {
        settlement: emptySettlement(),
        pointLoot: [
          {
            id: 'duplicate-anchor',
            position: { x: -20000, y: -20000 },
            points: 20,
            expiresAt: 2000,
          },
        ],
      }
    );
    const engine = new GameEngine(82, undefined, new InlineWorldPersistence(store));
    const home = { x: 15000, y: 5000 };
    const approach = { x: 13000, y: 5000 };
    try {
      const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), approach, 'hauler');
      engine.createAsteroids(0);
      for (const rock of engine.getAllAsteroids()) {
        engine.removeAsteroid(rock.id);
      }
      engine.parkSatellitePickups({ x: -24000, y: -24000 });
      const pickup = engine.getAllSatellitePickups()[0];
      assert(pickup);
      const id = domain === 'loot' ? 'duplicate-anchor' : pickup.id;
      if (domain === 'pickup-over-loot') {
        // Arrange the actual restoration owner with an accepted cross-domain ID.
        const loot: unknown = Reflect.get(engine, 'lootManager');
        assert(loot instanceof LootManager);
        loot.restorePoints([{ id, position: home, points: 20, expiresAt: 3000 }]);
        expect(loot.getNestResource(id)?.position).toEqual(home);
      }
      engine.addAsteroid({
        id,
        position: home,
        velocity: { x: 0, y: 0 },
        size: 40,
        jaggedness: 0,
        rotation: 0,
        angularVelocity: 0,
        health: 100,
        maxHealth: 100,
        vertices: 8,
        offsets: Array(8).fill(1),
        material: 'metal',
        ore: 'metal',
      });
      const step = (frames: number) => {
        for (let frame = 0; frame < frames; frame++) {
          pilot.position = { ...approach };
          pilot.velocity = { x: 0, y: 0 };
          engine.advanceOneFrame();
        }
      };
      const markers = () => engine.getSpiderField().nests.filter((nest) => nest.resourceId === id);
      step(1);
      expect(engine.getSpiderField().spiders).toHaveLength(10);
      expect(markers()).toEqual([]);
      clock.mockReturnValue(2000);
      step(60);
      if (domain === 'loot') {
        expect(markers()).toEqual([{ id: '3,1', resourceId: id, position: home }]);
      } else {
        expect(markers()).toEqual([]);
        if (domain === 'pickup-over-loot') {
          pilot.position = { x: -24000, y: -24000 };
          engine.tickSatellitePickups();
          expect(engine.getSatellitePickup(id)?.state).toBe('stored');
        } else {
          engine.parkSatellitePickups(home);
        }
        step(60);
        expect(markers()).toEqual([{ id: '3,1', resourceId: id, position: home }]);
      }
    } finally {
      engine.stopGameLoop();
      store.close();
      clock.mockRestore();
    }
  }
);
