/* @vitest-environment node */

import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import type { AsteroidData } from '../../../shared-types';
import { RecordingSocket } from '../../support/recordingSocket';

function addRubble(engine: GameEngine): AsteroidData {
  const rubble: AsteroidData = {
    id: 'rubble-ram-target',
    material: 'rubble',
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 50,
    jaggedness: 0.7,
    rotation: 0,
    angularVelocity: 0,
    health: 40,
    maxHealth: 40,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
  };
  engine.addAsteroid(rubble);
  return rubble;
}

describe('server authority boundaries', () => {
  let engine: GameEngine | undefined;

  afterEach(() => {
    engine?.stopGameLoop();
    engine = undefined;
  });

  test('an ability request cannot switch the kit selected at join', () => {
    engine = new GameEngine(42);
    const core = new WebSocketCore(engine);
    const ws = new RecordingSocket();
    core.handleClientMessage(
      {
        type: 'join',
        data: {
          id: 'pilot',
          name: 'Pilot',
          kitId: 'scout',
          position: { x: 0, y: 0 },
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: 1,
        },
      },
      ws
    );

    const pilot = engine.getPlayer('pilot');
    assert.ok(pilot, 'ability pilot');
    const maxHealth = pilot.maxHealth;

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'hauler', abilityId: 'harpoon' },
      },
      ws
    );

    expect(pilot.kitId).toBe('scout');
    expect(pilot.maxHealth).toBe(maxHealth);
    expect(engine.useAbility('pilot', 'hauler')).toBe(false);
    expect(pilot.abilityCooldownFrames).toBe(0);

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'scout', abilityId: 'surveyScan' },
      },
      ws
    );
    expect(pilot.kitId).toBe('scout');
    expect(pilot.abilityCooldownFrames).toBeGreaterThan(0);
  });

  test('a rammed rubble rock does not announce a cooperative split', () => {
    engine = new GameEngine(43);
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    delete pilot.spawnProtectionTimer;
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    const rubble = addRubble(engine);

    const results = engine.resolveAuthoritativeCombat();
    const result = results.find((entry) => entry.destroyedAsteroidId === rubble.id);
    assert.ok(result, 'rubble collision result');

    expect(result.newAsteroids).toEqual([]);
  });
});
