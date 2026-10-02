import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { GameEngine } from '../server/core/GameEngine';
import type { AsteroidData } from '../shared-types';

const REGIONAL_ASTEROID_SAMPLE_LIMIT = 32;

/** Full active-field digest and a deterministic bounded sample, outside measurement. */
export function regionalAsteroidEvidence(asteroids: readonly AsteroidData[]) {
  const ordered = [...asteroids].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  const digest = createHash('sha256');
  digest.update('[');
  for (const [index, asteroid] of ordered.entries()) {
    digest.update(`${index ? ',' : ''}${JSON.stringify(asteroid)}`);
  }
  digest.update(']');
  return {
    count: ordered.length,
    digest: digest.digest('hex'),
    sampleLimit: REGIONAL_ASTEROID_SAMPLE_LIMIT,
    samples: structuredClone(ordered.slice(0, REGIONAL_ASTEROID_SAMPLE_LIMIT)),
    unsampledRows: Math.max(0, ordered.length - REGIONAL_ASTEROID_SAMPLE_LIMIT),
  };
}

/** Observes the natural world without placement, resets, or generation calls. */
export function captureRegionalManifest(engine: GameEngine, seed: number) {
  assert.equal(
    engine.getWorldSeedForTesting(),
    seed,
    'Regional world seed differs from owned session'
  );
  const status = engine.getAsteroidFieldStatus();
  assert.equal(status.mode, 'regional', 'Regional benchmark field was replaced by a fixture');
  assert(status.activeSectors > 0 && status.asteroids > 0, 'Natural regional field has not woken');
  const state = engine.getSnapshotState();
  const asteroids = regionalAsteroidEvidence(engine.getAllAsteroids());
  assert.equal(asteroids.count, status.asteroids, 'Regional manifest count changed during capture');
  return {
    version: 1,
    scenario: 'regional-combat' as const,
    seed,
    field: status,
    counts: {
      players: status.players,
      asteroids: status.asteroids,
      pickups: state.satellitePickups.length,
      loot: engine.getLoot().length,
      mapAssets: state.mapAssets.length,
      spiders: state.spiderField?.spiders.length ?? 0,
      nests: state.spiderField?.nests.length ?? 0,
      explorationTiles: state.exploration.length,
    },
    observedPilots: state.entities.map((actor) => ({
      id: actor.id,
      position: { ...actor.position },
      velocity: { ...actor.velocity },
      angle: actor.angle,
      kitId: actor.kitId,
      health: actor.health,
      motionEpoch: actor.playerMotion?.epoch,
    })),
    asteroids,
    pickupSamples: state.satellitePickups.slice(0, 8),
    mapAssetSamples: state.mapAssets.slice(0, 8),
    spiderSamples: state.spiderField?.spiders.slice(0, 8) ?? [],
  };
}

export function validateRegionalManifest(value: unknown): void {
  assert(value && typeof value === 'object', 'Missing regional manifest');
  assert('scenario' in value && value.scenario === 'regional-combat', 'Wrong regional scenario');
  assert('field' in value);
  const field = parseRegionalStatus(value.field);
  assert(field.activeSectors > 0 && field.asteroids > 0, 'Empty regional field');
  assert('counts' in value && value.counts && typeof value.counts === 'object');
  assert('players' in value.counts && value.counts.players === field.players);
  assert('asteroids' in value.counts && value.counts.asteroids === field.asteroids);
  assert(
    'observedPilots' in value &&
      Array.isArray(value.observedPilots) &&
      value.observedPilots.length === field.players
  );
  assert('asteroids' in value && value.asteroids && typeof value.asteroids === 'object');
  const evidence = value.asteroids;
  assert('count' in evidence && evidence.count === field.asteroids);
  assert(
    'digest' in evidence &&
      typeof evidence.digest === 'string' &&
      /^[a-f0-9]{64}$/u.test(evidence.digest)
  );
  assert('sampleLimit' in evidence && evidence.sampleLimit === REGIONAL_ASTEROID_SAMPLE_LIMIT);
  assert('samples' in evidence && Array.isArray(evidence.samples));
  assert.equal(evidence.samples.length, Math.min(field.asteroids, REGIONAL_ASTEROID_SAMPLE_LIMIT));
  assert(
    'unsampledRows' in evidence &&
      evidence.unsampledRows === field.asteroids - evidence.samples.length
  );
}

export function parseRegionalStatus(value: unknown) {
  assert(value && typeof value === 'object');
  assert('mode' in value && value.mode === 'regional', 'Regional benchmark field mode changed');
  assert(
    'activeSectors' in value &&
      typeof value.activeSectors === 'number' &&
      Number.isSafeInteger(value.activeSectors) &&
      value.activeSectors >= 0
  );
  assert(
    'asteroids' in value &&
      typeof value.asteroids === 'number' &&
      Number.isSafeInteger(value.asteroids) &&
      value.asteroids >= 0
  );
  assert(
    'players' in value &&
      typeof value.players === 'number' &&
      Number.isSafeInteger(value.players) &&
      value.players >= 0
  );
  return {
    mode: value.mode,
    activeSectors: value.activeSectors,
    asteroids: value.asteroids,
    players: value.players,
  };
}
