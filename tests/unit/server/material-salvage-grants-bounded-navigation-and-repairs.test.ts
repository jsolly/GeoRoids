/* @vitest-environment node */
import { expect, test } from 'vitest';
import { NAVIGATION_SALVAGE } from '../../../shared/navigationSalvage';
import { GROWTH } from '../../../shared/shipGrowth';
import type { AsteroidMaterial } from '../../../shared-types';
import { GameServerWorld } from '../scenarios/support/gameServerWorld';

for (const material of ['ice', 'metal', 'rubble', 'crystal'] as const) {
  test(`${material} Resource Tap yields its material salvage through the actual extraction and collection path`, () => {
    const world = new GameServerWorld();
    try {
      const pilot = world.join('Salvager', { x: 0, y: 0 }, { kitId: 'hauler' });
      const actor = world.entity(pilot);
      actor.position = { x: 0, y: 0 };
      actor.health = 80;
      actor.equipment = ['resource_tap'];
      world.clearAsteroids();
      world.engine.addAsteroid({
        id: 'tap-material',
        material: material as AsteroidMaterial,
        position: { x: 80, y: 0 },
        velocity: { x: 0, y: 0 },
        size: 20,
        health: 100,
        maxHealth: 100,
        jaggedness: 0,
        rotation: 0,
        angularVelocity: 0,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
      world.send(pilot, {
        type: 'setHaulerUtility',
        id: pilot.id,
        data: { utilityId: 'resource_tap' },
      });
      world.send(pilot, { type: 'useAbility', id: pilot.id, data: {} });
      for (let i = 0; i < 23; i++) {
        world.engine.abilities.advance();
      }
      const drop = world.engine.getLoot().find((row) => row.kind === 'tap');
      expect(drop?.salvage).toBe(material);
      if (!drop) {
        throw new Error('Missing canister');
      }
      world.send(pilot, { type: 'useAbility', id: pilot.id, data: {} });
      for (let i = 0; i < GROWTH.TAP_LOOT_EJECT_FRAMES; i++) {
        world.engine.advanceOneFrame();
      }
      const settled = world.engine.getLoot().find((row) => row.id === drop.id);
      if (!settled) {
        throw new Error('Missing settled canister');
      }
      actor.position = { ...settled.position };
      const healthBeforeCollection = actor.health;
      world.engine.collectLoot();
      expect(world.engine.getLoot().some((row) => row.id === drop.id)).toBe(false);
      if (material === 'ice') {
        expect(actor.health).toBe(healthBeforeCollection + NAVIGATION_SALVAGE.iceRepair);
      }
      if (material === 'metal') {
        expect(actor.cargo).toBe(NAVIGATION_SALVAGE.metalCargo);
      }
      if (material === 'rubble') {
        expect(actor.silk).toBe(1);
      }
      if (material === 'crystal') {
        expect(actor.navigationAssistFrames).toBe(NAVIGATION_SALVAGE.frames);
        actor.contourDraftFrames = 2;
        world.engine.advanceCombatFrame();
        expect(actor.navigationAssistFrames).toBe(NAVIGATION_SALVAGE.frames - 1);
        expect(actor.contourDraftFrames).toBe(1);
        world.engine.advanceOneFrame();
        expect(actor.navigationAssistFrames).toBe(NAVIGATION_SALVAGE.frames - 2);
        expect(actor.contourDraftFrames).toBe(0);
        world.engine.collectLoot();
        expect(actor.navigationAssistFrames).toBe(NAVIGATION_SALVAGE.frames - 2);
        expect(
          world.engine.getSnapshotState().entities.find((row) => row.id === actor.id)
            ?.navigationAssistFrames
        ).toBe(NAVIGATION_SALVAGE.frames - 2);
      }
      expect(world.engine.getAsteroid('tap-material')?.health).toBe(100);
    } finally {
      world.dispose();
    }
  });
}
