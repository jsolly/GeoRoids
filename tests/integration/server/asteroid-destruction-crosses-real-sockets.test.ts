/* @vitest-environment node */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { GameEngine } from '../../../server/core/GameEngine';
import { createServerInstance } from '../../../server/createServer';
import { GAME, LASER, ROID } from '../../../shared/constants/gameplay';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../../../shared/snapshotProtocol';
import type { AsteroidData, ServerGameSnapshot } from '../../../shared-types';
import { closePlayerMotionScenario } from '../../support/playerMotionCleanup';
import { WireClient } from '../../support/wireClient';

function asteroidAt(
  id: string,
  size: number,
  position = { x: 400, y: 300 },
  extras: Partial<AsteroidData> = {}
): AsteroidData {
  return {
    id,
    position,
    velocity: { x: 0, y: 0 },
    size,
    jaggedness: 0.5,
    rotation: 0,
    angularVelocity: 0,
    health: size,
    maxHealth: size,
    vertices: 8,
    offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    ...extras,
  };
}

function isolateAsteroid(engine: GameEngine, asteroid: AsteroidData): void {
  for (const existing of engine.getAllAsteroids()) {
    engine.removeAsteroid(existing.id);
  }
  engine.addAsteroid(asteroid);
}

describe('Asteroid destruction over real sockets', () => {
  let server: ReturnType<typeof createServerInstance> | null = null;
  let port = 0;
  let client: WireClient | undefined;

  afterEach(async () => {
    try {
      await closePlayerMotionScenario({
        clients: client ? [client] : [],
        server: server ?? undefined,
      });
      client?.assertHealthy();
    } finally {
      server = null;
      client = undefined;
      port = 0;
    }
  });

  test.each([
    { size: 'medium', radius: 20, points: ROID.POINTS_MEDIUM, shots: 1 },
    { size: 'large', radius: 40, points: ROID.POINTS_LARGE, shots: 1 },
  ])(
    'one pilot shoots a $size ice rock and receives its removal without fragments',
    async ({ radius, points, shots }) => {
      server = createServerInstance({ port: 0, nodeEnv: 'test' });
      server.gameEngine.stopGameLoop();
      server.wsCore.stopPeriodicGameStateBroadcast();
      port = await server.listening;

      const decoder = new SnapshotDecoder('live');
      const states: ServerGameSnapshot[] = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=1&explorationVersion=1`
      );
      const wire = new WireClient(ws);
      client = wire;
      const received = wire.messages;
      ws.on('message', (raw) => {
        try {
          const text = String(raw);
          const result = decoder.readMessage(text, { acceptSnapshots: true });
          if (result.kind === 'snapshot-rejected') {
            throw result.error;
          }
          if (result.kind === 'snapshot') {
            states.push(result.state);
            if (ws.readyState === WebSocket.OPEN) {
              wire.send({ type: 'snapshotAck', data: { sequence: result.metadata.sequence } });
            }
            return;
          }
          const message = result.message;
          assert.ok(typeof message === 'object' && message !== null);
          assert.ok('type' in message && typeof message.type === 'string');
          assert.ok('data' in message);
          if (message.type === 'joined') {
            decoder.reset();
          }
        } catch (error) {
          wire.failures.push(
            error instanceof Error ? error : new Error('Invalid decoded snapshot', { cause: error })
          );
        }
      });
      await wire.open();
      ws.send(
        JSON.stringify({
          type: 'join',
          data: {
            id: 'shooter',
            name: 'Shooter',
            position: { x: 800, y: 800 },
            snapshotVersion: SNAPSHOT_VERSION,
            asteroidInteractions: 1,
            explorationVersion: 1,
          },
        })
      );
      await wire.barrier();
      expect(received.filter((message) => message.type === 'joined')).toHaveLength(1);
      const pilot = server.gameEngine.getPlayer('shooter');
      assert.ok(pilot);
      // Join keeps a town-ring arrival. The shot corridor is arranged at the requested yard.
      expect(
        server.gameEngine.playerMotion.placeActorForTesting(
          pilot.id,
          { x: 800, y: 800 },
          server.gameEngine.getServerTime()
        )
      ).toBe(true);
      // Keep the stopped world's other laser targets far from the shot corridor.
      server.gameEngine.parkSatellitePickups({ x: -2400, y: -2400 });
      expect(server.gameEngine.getLoot()).toEqual([]);
      const targetPosition = { x: 800 + radius + 30, y: 800 };
      const target = asteroidAt('solo-ice', radius, { ...targetPosition }, { material: 'ice' });
      isolateAsteroid(server.gameEngine, target);
      const untouched = asteroidAt('untouched-ice', 20, { x: 0, y: -900 }, { material: 'ice' });
      server.gameEngine.addAsteroid(untouched);
      const scoreBefore = pilot.score;
      const now = Date.now();
      const clock = vi.spyOn(server.gameEngine, 'getServerTime').mockReturnValue(now);
      received.length = 0;
      states.length = 0;
      try {
        for (let shot = 0; shot < shots; shot++) {
          clock.mockReturnValue(now + shot * 200);
          ws.send(
            JSON.stringify({
              type: 'shoot',
              id: pilot.id,
              laserStart: { x: targetPosition.x - radius - 2, y: targetPosition.y },
              laserDirection: { x: LASER.SPEED / GAME.FPS, y: 0 },
            })
          );
          await wire.barrier();
          expect(server.gameEngine.getServerLasers()).toHaveLength(1);
          // Advance only the actual projectile pipeline. The stopped world cannot
          // supply an NPC hit, pickup score, expiry, or replacement asteroid.
          const hits = server.gameEngine.advanceLasersAndResolveHits();
          server.wsCore.getMessageHandler().broadcastAppliedAsteroidHits(hits);
          await wire.barrier();
        }
        server.wsCore.getBroadcaster().broadcastGameState();
        await wire.barrier();
        expect(server.gameEngine.getServerLasers()).toHaveLength(0);
        expect(received.filter((message) => message.type === 'asteroidDestroy')).toEqual([
          {
            type: 'asteroidDestroy',
            data: { asteroidId: target.id, origin: targetPosition },
          },
        ]);
        expect(received.filter((message) => message.type === 'asteroidCreateBatch')).toEqual([]);
        expect(states.at(-1)?.entities.find((entity) => entity.id === pilot.id)?.score).toBe(
          scoreBefore
        );
        expect(server.gameEngine.getAllAsteroids().map((asteroid) => asteroid.id)).toEqual([
          untouched.id,
        ]);
        expect(pilot.score).toBe(scoreBefore);
        expect(server.gameEngine.getLoot().find((drop) => drop.kind === 'points')?.points).toBe(
          points
        );
        expect(states.at(-1)?.asteroids.map((asteroid) => asteroid.id)).toEqual([untouched.id]);
      } finally {
        clock.mockRestore();
      }
    }
  );
});
