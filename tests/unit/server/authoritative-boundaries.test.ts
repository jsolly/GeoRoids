/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
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

function join(core: WebSocketCore, socket: RecordingSocket, data: Record<string, unknown>): void {
  core.handleClientMessage(
    { type: 'join', data: { ...data, snapshotVersion: 1, asteroidInteractions: 1 } },
    socket
  );
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
          kitId: 'dart',
          position: { x: 0, y: 0 },
          snapshotVersion: 1,
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

    expect(pilot.kitId).toBe('dart');
    expect(pilot.maxHealth).toBe(maxHealth);
    expect(engine.useAbility('pilot', 'hauler')).toBe(false);
    expect(pilot.abilityCooldownFrames).toBe(0);

    core.handleClientMessage(
      {
        type: 'useAbility',
        id: 'pilot',
        data: { kitId: 'dart', abilityId: 'boostDash' },
      },
      ws
    );
    expect(pilot.kitId).toBe('dart');
    expect(pilot.abilityCooldownFrames).toBeGreaterThan(0);
  });

  test('initAsteroids only serves the joined socket owner', () => {
    engine = new GameEngine(45);
    const core = new WebSocketCore(engine);
    const ownerWs = new RecordingSocket();
    const otherWs = new RecordingSocket();
    const unjoinedWs = new RecordingSocket();
    join(core, ownerWs, { id: 'owner', name: 'Owner', position: { x: 0, y: 0 } });
    join(core, otherWs, { id: 'other', name: 'Other', position: { x: 100, y: 0 } });
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }

    const request = {
      type: 'initAsteroids',
      id: 'owner',
      data: { asteroidCount: 999_999 },
    };
    core.handleClientMessage(request, otherWs);
    core.handleClientMessage(request, unjoinedWs);
    expect(engine.getAsteroidCount()).toBe(0);

    core.handleClientMessage(request, ownerWs);
    expect(engine.getAsteroidCount()).toBeGreaterThan(0);
  });

  test('a rammed rubble rock does not announce a cooperative split', () => {
    engine = new GameEngine(43);
    const pilot = engine.addPlayer('pilot', 'Pilot', new RecordingSocket(), { x: 0, y: 0 });
    delete pilot.spawnProtectionTimer;
    for (const asteroid of engine.getAllAsteroids()) {
      engine.removeAsteroid(asteroid.id);
    }
    const rubble = addRubble(engine);

    const results = engine.resolveAuthoritativeCombat(1_000);
    const result = results.find((entry) => entry.destroyedAsteroidId === rubble.id);
    assert.ok(result, 'rubble collision result');

    expect(result.collabSplit).toBe(false);
    expect(result.newAsteroids).toEqual([]);
  });
});
