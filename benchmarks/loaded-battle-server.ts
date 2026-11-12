import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createServerInstance } from '../server/createServer';
import { serverPerformanceMetrics } from '../server/performanceMetrics';
import { flushServerLogs } from '../setup/serverLogger';
import { applyShipKitStats } from '../shared/shipKits';
import { attachTowCable } from '../shared/towCable';
import { ownBenchmarkIdentity } from './benchmark-identity';
import { writeFixtureManifest } from './fixture-manifest';

const requestedDirectory = process.env['GEOROIDS_LOADED_PROFILE_DIRECTORY'];
assert(requestedDirectory, 'Missing owned profile directory');
const directory: string = requestedDirectory;
const scene = process.env['GEOROIDS_LOADED_SCENE'];
assert(scene === 'endurance' || scene === 'natural');
const participants = Number(process.env['GEOROIDS_LOADED_PILOTS']);
assert([10, 25, 50, 100].includes(participants));
assert(!process.env['GEOROIDS_WORLD_PATH'], 'Loaded fixture must not open a saved world');
const identity = ownBenchmarkIdentity(42);
const server = createServerInstance({
  port: 0,
  nodeEnv: 'test',
  seed: 42,
  debugReports: false,
  ...(process.env['GEOROIDS_LOADED_PERSISTENCE'] === '1'
    ? { worldPath: join(directory, 'world.sqlite') }
    : {}),
});
const inspector = new Session();
inspector.connect();
let profiling = false;
let startedAt = 0;
let cpuStart = process.cpuUsage();
let stopping = false;
const samples: ReturnType<typeof sample>[] = [];
let sampling: NodeJS.Timeout | undefined;
const originalRocks = new Set<string>();

function sample() {
  const engine = server.gameEngine;
  const players = engine.getAllPlayers();
  const rocks = engine.getAllAsteroids();
  return {
    elapsedMs: performance.now() - startedAt,
    gameTime: engine.getSimulationClock().gameTime,
    players: players.length,
    alive: players.filter((player) => player.health > 0 && !player.exploding).length,
    asteroids: rocks.length,
    asteroidHealth: rocks.reduce((sum, rock) => sum + rock.health, 0),
    damagedAsteroids: rocks.filter((rock) => rock.health < rock.maxHealth).length,
    originalAsteroidsRemaining: rocks.filter((rock) => originalRocks.has(rock.id)).length,
    towing: players.filter(
      (player) => player.harpoonTargetId && engine.getAsteroid(player.harpoonTargetId)
    ).length,
    projectiles: engine.getServerLasers().length,
    towTargets: players.flatMap((player) => {
      const rock = player.harpoonTargetId ? engine.getAsteroid(player.harpoonTargetId) : undefined;
      return rock
        ? [
            {
              owner: player.id,
              id: rock.id,
              position: { ...rock.position },
              velocity: { ...rock.velocity },
            },
          ]
        : [];
    }),
    memory: process.memoryUsage(),
  };
}

async function send(message: object) {
  await new Promise<void>((resolve, reject) => {
    assert(process.send && process.connected, 'Loaded driver IPC unavailable');
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function stop(failure?: unknown) {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(sampling);
  const watchdog = setTimeout(() => process.exit(1), 5000).unref();
  try {
    await server.close();
    inspector.disconnect();
    identity.release();
    assert(await flushServerLogs(), 'Loaded server logs did not flush');
    if (failure !== undefined) {
      throw failure;
    }
    await send({ type: 'closed' });
    clearTimeout(watchdog);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}

async function command(message: unknown) {
  assert(message !== null && typeof message === 'object' && 'type' in message);
  const engine = server.gameEngine;
  switch (message.type) {
    case 'arrange': {
      const actors = engine.getAllPlayers();
      assert.equal(actors.length, participants);
      assert.deepEqual(
        actors.map((actor) => actor.id).sort((left, right) => left.localeCompare(right)),
        Array.from({ length: participants }, (_, index) => `benchmark-${index}`).sort(
          (left, right) => left.localeCompare(right)
        )
      );
      assert(
        actors.every((actor) => actor.ws),
        'Synthetic pilot lacks transport'
      );
      engine.prepareDiagnosticWorld('combat');
      const rocks = engine.getAllAsteroids();
      assert.equal(rocks.length, 80);
      for (const rock of rocks) {
        originalRocks.add(rock.id);
      }
      for (const [index, rock] of rocks.entries()) {
        engine.updateAsteroid(rock.id, {
          position: { x: 500 + (index % 10) * 150, y: -600 + Math.floor(index / 10) * 170 },
          velocity: { x: 0, y: 0 },
          ...(scene === 'endurance'
            ? { material: 'metal', health: 100_000, maxHealth: 100_000 }
            : {}),
        });
      }
      for (const [index, actor] of actors.entries()) {
        const position =
          index < 10
            ? { x: index < 5 ? -700 : 2300, y: -600 + (index % 5) * 250 }
            : { x: -650 + ((index - 10) % 15) * 80, y: 850 + Math.floor((index - 10) / 15) * 80 };
        applyShipKitStats(actor, index >= 5 && index < 10 ? 'hauler' : 'scout');
        actor.health = actor.maxHealth;
        actor.exploding = false;
        delete actor.respawnTimer;
        actor.harpoonTargetId = null;
        actor.abilityCooldownFrames = 0;
        actor.haulerUtility = 'tow_cable';
        assert(
          engine.playerMotion.placeActorForTesting(actor.id, position, engine.getServerTime())
        );
        engine.updatePlayer(actor.id, {
          position,
          velocity: { x: 0, y: 0 },
          angle: 0,
          thrusting: false,
        });
        const rock = index < 10 ? rocks[index] : undefined;
        if (rock) {
          engine.updateAsteroid(rock.id, {
            position: { x: position.x + (index < 5 ? 150 : -150), y: position.y },
            size: 30,
          });
        }
        if (index >= 5 && index < 10) {
          assert(rock);
          actor.harpoonTargetId = rock.id;
          actor.harpoonLatchPos = { ...rock.position };
          attachTowCable(actor, rock);
        }
        assert(actor.ws);
        assert(server.wsCore.getBroadcaster().requestSnapshotKeyframe(actor.ws));
      }
      const manifest = {
        seed: 42,
        players: actors.map(({ ws: _ws, ...actor }) => actor),
        asteroids: rocks,
      };
      const hash = await writeFixtureManifest(join(directory, 'fixture.json'), manifest);
      await send({
        type: 'arranged',
        hash,
      });
      break;
    }
    case 'begin':
      assert(!profiling);
      assert('profile' in message && typeof message.profile === 'boolean');
      profiling = message.profile;
      if (profiling) {
        await inspector.post('Profiler.enable');
        await inspector.post('Profiler.setSamplingInterval', { interval: 1000 });
        await inspector.post('HeapProfiler.enable');
        await inspector.post('HeapProfiler.startSampling', {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        await inspector.post('Profiler.start');
      }
      serverPerformanceMetrics.exportWindow();
      startedAt = performance.now();
      cpuStart = process.cpuUsage();
      samples.push(sample());
      sampling = setInterval(() => samples.push(sample()), 1000);
      await send({ type: 'begun' });
      break;
    case 'end': {
      clearInterval(sampling);
      samples.push(sample());
      const elapsedMs = performance.now() - startedAt;
      const cpu = process.cpuUsage(cpuStart);
      const metrics = serverPerformanceMetrics.exportWindow();
      const first = samples[0];
      const last = samples.at(-1);
      assert(first !== undefined && last !== undefined);
      const movedTowTargets = first.towTargets.filter((before) =>
        last.towTargets.some(
          (after) =>
            after.id === before.id &&
            (after.position.x !== before.position.x || after.position.y !== before.position.y)
        )
      ).length;
      const workload = {
        playersPresent: samples.every((row) => row.players === participants),
        asteroidRange: {
          minimum: Math.min(...samples.map((row) => row.asteroids)),
          maximum: Math.max(...samples.map((row) => row.asteroids)),
        },
        towRange: {
          minimum: Math.min(...samples.map((row) => row.towing)),
          maximum: Math.max(...samples.map((row) => row.towing)),
        },
        movedTowTargets,
        damageOrDestructionObserved:
          last.asteroidHealth < first.asteroidHealth ||
          last.originalAsteroidsRemaining < first.originalAsteroidsRemaining,
        originalAsteroidsDestroyed:
          first.originalAsteroidsRemaining - last.originalAsteroidsRemaining,
        peakNewAsteroids: Math.max(
          ...samples.map((row) => row.asteroids - row.originalAsteroidsRemaining)
        ),
      };
      if (profiling) {
        const cpuProfile = await inspector.post('Profiler.stop');
        const heapProfile = await inspector.post('HeapProfiler.stopSampling');
        await writeFile(join(directory, 'server.cpuprofile'), JSON.stringify(cpuProfile.profile));
        await writeFile(join(directory, 'server.heapprofile'), JSON.stringify(heapProfile.profile));
      }
      const result = {
        elapsedMs,
        cpu,
        samples,
        workload,
        metrics,
        closedWindows: serverPerformanceMetrics.read().closedWindows,
        diagnostics: engine.getDiagnostics(),
      };
      await writeFile(join(directory, 'server.json'), JSON.stringify(result, null, 2));
      await send({ type: 'ended', workload });
      break;
    }
    case 'shutdown':
      await stop();
      break;
    default:
      throw new Error('Unknown loaded-battle command');
  }
}

let commands = Promise.resolve();
process.on('message', (message: unknown) => {
  commands = commands.then(() => command(message)).catch(stop);
});
process.once('disconnect', () => {
  if (!stopping) {
    void stop(new Error('Loaded driver disconnected'));
  }
});
process.once('SIGTERM', () => {
  void stop(new Error('Loaded server terminated'));
});
process.once('uncaughtException', (error) => {
  void stop(error);
});
process.once('unhandledRejection', (error: unknown) => {
  void stop(error);
});
await send({ type: 'ready', port: await server.listening });
