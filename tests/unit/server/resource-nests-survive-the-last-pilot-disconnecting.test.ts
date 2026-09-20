/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SPIDER } from '../../../shared/terrainSpider';
import { DAMAGE } from '../../../src/constants';
import { RecordingSocket } from '../../support/recordingSocket';

test('the last pilot disconnecting preserves a wounded resource guard and its slain nestmate', () => {
  const engine = new GameEngine(81);
  const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 3000, y: 5000 });
  engine.prepareDiagnosticWorld('traversal');
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.parkSatellitePickups();
  pilot.position = { x: 3000, y: 5000 };
  engine.addAsteroid({
    id: 'guarded-metal',
    position: { x: 5000, y: 5000 },
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
  engine.advanceCombatFrame();
  const [wounded, killed] = engine.getSpiderField().spiders;
  assert(wounded && killed);
  assert(engine.spawnLaser(pilot.id, wounded.position, { x: 1, y: 0 }));
  engine.advanceLasersAndResolveHits();
  for (let i = 0; i < 3; i++) {
    assert(engine.spawnLaser(pilot.id, killed.position, { x: 1, y: 0 }));
    engine.advanceLasersAndResolveHits();
  }
  const before = engine.getSpiderField().spiders.map(({ id, health }) => ({ id, health }));
  expect(before).toHaveLength(3);
  expect(before.find(({ id }) => id === wounded.id)?.health).toBe(
    SPIDER.MAX_HEALTH - DAMAGE.LASER_HIT
  );
  engine.removePlayer(pilot.id);
  expect(engine.getSpiderField().spiders).toEqual([]);
  engine.addPlayer('returning', 'Returning', new RecordingSocket(), { x: 3000, y: 5000 });
  engine.advanceCombatFrame();
  expect(engine.getSpiderField().spiders.map(({ id, health }) => ({ id, health }))).toEqual(before);
  engine.stopGameLoop();
});
