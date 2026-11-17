/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { DAMAGE } from '../../../shared/constants/gameplay';
import { SPIDER } from '../../../shared/terrainSpider';
import { RecordingSocket } from '../../support/recordingSocket';

test.each(['full', 'combat-only'] as const)(
  '%s: the last pilot disconnecting preserves a wounded resource guard and its slain nestmate',
  (mode) => {
    const engine = new GameEngine(81);
    const advance = () =>
      mode === 'full' ? engine.advanceOneFrame() : engine.advanceCombatFrame();
    try {
      const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), {
        x: 13_000,
        y: 5_000,
      });
      engine.prepareDiagnosticWorld('traversal');
      for (const rock of engine.getAllAsteroids()) {
        engine.asteroidLifecycle.remove(rock.id);
      }
      engine.parkSatellitePickups();
      pilot.position = { x: 13_000, y: 5_000 };
      engine.asteroidLifecycle.insert({
        id: 'guarded-metal',
        position: { x: 15_000, y: 5_000 },
        velocity: { x: 0, y: 0 },
        size: 24,
        health: 75,
        maxHealth: 75,
        material: 'metal',
        jaggedness: 0.5,
        rotation: 0,
        angularVelocity: 0,
        vertices: 4,
        offsets: [1, 1, 1, 1],
      });
      advance();
      const [wounded, killed] = engine.getSpiderField().spiders;
      assert(wounded && killed);
      const graze = engine.laserCombat.spawn(pilot.id, wounded.position, { x: 1, y: 0 });
      assert(graze);
      graze.energy = 0.5;
      engine.laserCombat.advance();
      assert(engine.laserCombat.spawn(pilot.id, killed.position, { x: 1, y: 0 }));
      engine.laserCombat.advance();
      const before = engine.getSpiderField().spiders.map(({ id, health }) => ({ id, health }));
      expect(before).toHaveLength(SPIDER.NEST_GUARDS - 1);
      expect(before.find(({ id }) => id === wounded.id)?.health).toBe(
        SPIDER.MAX_HEALTH - DAMAGE.LASER_HIT * 0.5
      );
      engine.removePlayer(pilot.id);
      expect(engine.getSpiderField().spiders).toEqual([]);
      advance();
      expect(engine.getSpiderField().spiders).toEqual([]);
      engine.addPlayer('returning', 'Returning', new RecordingSocket(), { x: 13_000, y: 5_000 });
      advance();
      expect(engine.getSpiderField().spiders.map(({ id, health }) => ({ id, health }))).toEqual(
        before
      );
    } finally {
      engine.stopGameLoop();
    }
  }
);
