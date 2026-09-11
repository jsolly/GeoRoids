import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import WebSocket from 'ws';
import type { createServerInstance } from '../server/createServer';
import { serverPerformanceMetrics } from '../server/performanceMetrics';
import { radiusFromMass, resetShipMass } from '../shared/shipGrowth';
import type { AsteroidData } from '../shared-types';
import { FUEL } from '../src/constants';
import { applyShipKitStats } from '../src/entities/ship/shipKits';
import { clearShield } from '../src/entities/ship/shipShield';

export function normalizeFixtureAsteroids(asteroids: AsteroidData[]) {
  const slots = new Map(asteroids.map((asteroid, index) => [asteroid.id, `asteroid-${index}`]));
  return asteroids.map(({ id, phenomenon, ...asteroid }) => ({
    ...asteroid,
    id: slots.get(id),
    ...(phenomenon
      ? {
          phenomenon: {
            ...phenomenon,
            ...('clusterId' in phenomenon
              ? { clusterId: slots.get(phenomenon.clusterId) ?? phenomenon.clusterId }
              : {}),
          },
        }
      : {}),
  }));
}

type FixtureRequest = { scenario: 'traversal' | 'combat'; participants: string[] };
function parseRequest(value: unknown): FixtureRequest {
  assert(value && typeof value === 'object' && 'scenario' in value && 'participants' in value);
  assert(value.scenario === 'traversal' || value.scenario === 'combat', 'Unknown scenario');
  assert(
    Array.isArray(value.participants) && value.participants.every((id) => typeof id === 'string')
  );
  assert(
    value.participants.length === (value.scenario === 'combat' ? 5 : 1),
    'Wrong participant count'
  );
  assert(new Set(value.participants).size === value.participants.length, 'Duplicate participants');
  return { scenario: value.scenario, participants: value.participants };
}

export async function startFixtureControl(
  server: ReturnType<typeof createServerInstance>,
  path: string,
  seed: number
) {
  let epoch = 0;
  const sockets = new Set<Socket>();
  const control = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10_000, () => socket.destroy());
    let data = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) {
        return;
      }
      data += chunk.toString();
      if (data.length > 8192) {
        socket.destroy();
        return;
      }
      if (!data.includes('\n')) {
        return;
      }
      handled = true;
      try {
        const command: unknown = JSON.parse(data);
        if (
          command &&
          typeof command === 'object' &&
          'operation' in command &&
          command.operation === 'finalizeMetrics'
        ) {
          assert.deepEqual(Object.keys(command), ['operation']);
          const finalized = serverPerformanceMetrics.exportWindow();
          socket.end(
            `${JSON.stringify({ ...finalized, closedWindows: serverPerformanceMetrics.read().closedWindows })}\n`
          );
          return;
        }
        const request = parseRequest(command);
        const engine = server.gameEngine;
        const joined = engine.getAllPlayers();
        const present = new Set(
          joined
            .filter((player) => player.ws?.readyState === WebSocket.OPEN)
            .map((player) => player.id)
        );
        assert(
          joined.every((player) => request.participants.includes(player.id)),
          'Unexpected joined participant'
        );
        const missing = request.participants.filter((id) => !present.has(id));
        if (missing.length > 0) {
          socket.end(`${JSON.stringify({ kind: 'pending', missing })}\n`);
          return;
        }
        const players = request.participants.map((id) => {
          const player = engine.getPlayer(id);
          assert(player);
          return player;
        });
        // This synchronous callback runs between simulation ticks. No HTTP route or production hook.
        engine.prepareDiagnosticWorld(request.scenario);
        const actors = [...players, ...engine.getAllBots()];
        for (const [index, actor] of actors.entries()) {
          resetShipMass(actor);
          applyShipKitStats(actor, actor.kitId);
          clearShield(actor);
          // Network-facing updatePlayer deliberately ignores these authority-owned fields.
          actor.fuel = FUEL.START;
          actor.maxFuel = FUEL.MAX;
          actor.healthRegenTimer = 0;
          delete actor.respawnTimer;
          delete actor.explodeTime;
          delete actor.deathCause;
          delete actor.laserUpgrade;
          delete actor.harpoonTargetId;
          delete actor.harpoonLatchPos;
          const angle = (index * Math.PI * 2) / actors.length;
          const position = { x: Math.cos(angle) * 100, y: Math.sin(angle) * 100 };
          if (actor.type === 'human') {
            assert(
              engine.playerMotion.placeActorForTesting(actor.id, position, engine.getServerTime()),
              'Human fixture motion session absent'
            );
          }
          engine.updatePlayer(actor.id, {
            position,
            velocity: { x: 0, y: 0 },
            angle,
            health: actor.maxHealth,
            exploding: false,
            lives: 3,
            score: 0,
            abilityCooldownFrames: 0,
            abilityActiveFrames: 0,
            shieldTimer: 0,
            harpoonTimer: 0,
          });
        }
        if (request.scenario === 'combat') {
          const positions = [
            { x: -175, y: 0 },
            { x: 175, y: 0 },
            { x: 0, y: -250 },
            { x: 0, y: 250 },
          ];
          for (const [index, position] of positions.entries()) {
            const asteroid = engine.getAllAsteroids()[index];
            assert(asteroid);
            engine.updateAsteroid(asteroid.id, { position, size: 30 });
          }
        }
        for (const [index, actor] of actors.entries()) {
          for (const other of actors.slice(index + 1)) {
            assert(
              Math.hypot(actor.position.x - other.position.x, actor.position.y - other.position.y) >
                radiusFromMass(actor.mass) + radiusFromMass(other.mass) + 20,
              'Fixture hulls overlap'
            );
          }
        }
        for (const [index, asteroid] of engine.getAllAsteroids().entries()) {
          const clearsHulls = () =>
            actors.every(
              (actor) =>
                Math.hypot(
                  actor.position.x - asteroid.position.x,
                  actor.position.y - asteroid.position.y
                ) >
                radiusFromMass(actor.mass) + asteroid.size + 20
            );
          if (!clearsHulls()) {
            const angle = index * 2.399963229728653;
            engine.updateAsteroid(asteroid.id, {
              position: { x: Math.cos(angle) * 900, y: Math.sin(angle) * 900 },
            });
          }
          assert(clearsHulls(), 'Fixture asteroid overlaps a hull');
        }
        const state = engine.getGameState();
        const counts = {
          humans: players.length,
          bots: engine.getAllBots().length,
          asteroids: engine.getAsteroidCount(),
          satellites: engine.getSatelliteCount(),
          pickups: engine.getSatellitePickupCount(),
        };
        if (request.scenario === 'combat') {
          assert.deepEqual(counts, {
            humans: 5,
            bots: 2,
            asteroids: 80,
            satellites: 6,
            pickups: 2,
          });
        }
        const baselines = players.map((player) => {
          assert(player.ws, 'Participant has no transport');
          const sequence = server.wsCore.getBroadcaster().requestSnapshotKeyframe(player.ws);
          assert(sequence !== undefined, 'Participant has no snapshot negotiation');
          return { id: player.id, sequence };
        });
        const manifest = {
          version: 1,
          seed,
          scenario: request.scenario,
          counts,
          placements: actors.map((actor, index) => ({
            slot: index,
            type: actor.type,
            position: actor.position,
            angle: actor.angle,
            kitId: actor.kitId,
            mass: actor.mass,
            health: actor.health,
            fuel: actor.fuel,
          })),
          asteroids: normalizeFixtureAsteroids(engine.getAllAsteroids()),
          satellites: engine.getAllSatellites().map(({ id: _id, ...satellite }) => satellite),
          pickups: engine.getAllSatellitePickups().map(({ id: _id, ...pickup }) => pickup),
          playerProjectiles: engine.getPlayerProjectiles(),
          satelliteProjectiles: engine.getActiveSatelliteProjectiles(),
        };
        const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
        socket.end(
          `${JSON.stringify({ manifest, hash, epoch: ++epoch, gameTime: state.gameTime, baselines, participants: request.participants })}\n`
        );
      } catch (error) {
        socket.end(`${JSON.stringify({ error: String(error) })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    control.once('error', reject);
    control.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) =>
      control.close((error) => (error ? reject(error) : resolve()))
    );
  };
}

async function requestControl(path: string, request: object): Promise<unknown> {
  const socket = createConnection(path);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      let data = '';
      socket.setTimeout(10_000, () => reject(new Error('Fixture control timed out')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.length > 1024 * 1024) {
          reject(new Error('Fixture response too large'));
        }
      });
      socket.on('end', () => {
        try {
          const value: unknown = JSON.parse(data);
          assert(value && typeof value === 'object');
          assert(!('error' in value), 'error' in value ? String(value.error) : 'Fixture error');
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    socket.destroy();
  }
}

export async function finalizeServerWindow(path: string) {
  const value = await requestControl(path, { operation: 'finalizeMetrics' });
  assert(value && typeof value === 'object' && 'window' in value);
  const window = value.window;
  assert(
    window &&
      typeof window === 'object' &&
      'id' in window &&
      typeof window.id === 'string' &&
      'finalized' in window &&
      window.finalized === true &&
      'startedAt' in window &&
      typeof window.startedAt === 'string' &&
      'endedAt' in window &&
      typeof window.endedAt === 'string'
  );
  return { summary: value, id: window.id, startedAt: window.startedAt, endedAt: window.endedAt };
}

export async function prepareFixture(path: string, request: FixtureRequest) {
  const value = await requestControl(path, request);
  assert(value && typeof value === 'object');
  if ('kind' in value && value.kind === 'pending') {
    assert('missing' in value && Array.isArray(value.missing) && value.missing.length > 0);
    const missing = value.missing.map((id: unknown) => {
      assert(
        typeof id === 'string' && request.participants.includes(id),
        'Unknown pending participant'
      );
      return id;
    });
    assert(new Set(missing).size === missing.length, 'Duplicate pending participant');
    return { kind: 'pending' as const, missing };
  }
  assert('hash' in value && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash));
  assert('epoch' in value && typeof value.epoch === 'number');
  assert('gameTime' in value && typeof value.gameTime === 'number');
  assert('manifest' in value && 'baselines' in value && Array.isArray(value.baselines));
  const baselines = value.baselines.map((entry: unknown) => {
    assert(
      entry &&
        typeof entry === 'object' &&
        'id' in entry &&
        typeof entry.id === 'string' &&
        'sequence' in entry &&
        typeof entry.sequence === 'number' &&
        Number.isSafeInteger(entry.sequence) &&
        entry.sequence > 0
    );
    return { id: entry.id, sequence: entry.sequence };
  });
  assert.deepEqual(
    baselines.map((entry) => entry.id).sort(),
    [...request.participants].sort(),
    'Fixture baseline recipients differ'
  );
  assert.equal(
    createHash('sha256').update(JSON.stringify(value.manifest)).digest('hex'),
    value.hash,
    'Fixture hash mismatch'
  );
  return {
    kind: 'prepared' as const,
    manifest: value.manifest,
    hash: value.hash,
    epoch: value.epoch,
    gameTime: value.gameTime,
    baselines,
  };
}
