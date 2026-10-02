import { expect, test } from 'vitest';
import { observesPreparedFixture } from '../../../benchmarks/fixture-readiness';
import {
  captureRegionalManifest,
  parseRegionalStatus,
  regionalAsteroidEvidence,
  validateRegionalManifest,
} from '../../../benchmarks/regional-fixture';
import { GameEngine } from '../../../server/core/GameEngine';
import { RecordingSocket } from '../../support/recordingSocket';

test('observing natural pilots preserves their real spawns and every generated asteroid', () => {
  const engine = new GameEngine(42);
  for (let index = 0; index < 5; index++) {
    const socket = new RecordingSocket();
    const actor = engine.addPlayer(`pilot-${index}`, `Pilot ${index}`, socket);
    engine.enableAsteroidInteractions(actor);
    expect(engine.registerPilot(actor, socket).ok).toBe(true);
  }
  const before = structuredClone(engine.getGameState());
  const manifest = captureRegionalManifest(engine, 42);
  validateRegionalManifest(manifest);
  expect(manifest.field).toMatchObject({ mode: 'regional', players: 5 });
  expect(manifest.field.activeSectors).toBeGreaterThan(0);
  expect(manifest.asteroids.count).toBe(before.asteroids.length);
  expect(manifest.asteroids.samples).toHaveLength(32);
  expect(manifest.asteroids.unsampledRows).toBe(before.asteroids.length - 32);
  expect(engine.getAllAsteroids()).toEqual(before.asteroids);
  expect(
    engine
      .getAllPlayers()
      .map((actor) => ({ position: actor.position, epoch: actor.playerMotion?.epoch }))
  ).toEqual(
    before.entities.map((actor) => ({ position: actor.position, epoch: actor.playerMotion?.epoch }))
  );
  const finalRock = [...engine.getAllAsteroids()]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .at(-1);
  expect(finalRock).toBeDefined();
  if (!finalRock) {
    throw new Error('Natural world is empty');
  }
  expect(manifest.asteroids.samples.some((sample) => sample.id === finalRock.id)).toBe(false);
  const sameRowsReordered = regionalAsteroidEvidence([...engine.getAllAsteroids()].reverse());
  expect(sameRowsReordered.digest).toBe(manifest.asteroids.digest);
  engine.updateAsteroid(finalRock.id, { health: finalRock.health - 1 });
  const changed = captureRegionalManifest(engine, 42);
  expect(changed.asteroids.digest).not.toBe(manifest.asteroids.digest);
  expect(changed.asteroids.samples).toEqual(manifest.asteroids.samples);
  expect(Buffer.byteLength(JSON.stringify(manifest), 'utf8')).toBeLessThanOrEqual(1024 * 1024);
  expect(() =>
    validateRegionalManifest({ ...manifest, field: { ...manifest.field, mode: 'fixture' } })
  ).toThrow('field mode changed');
  expect(() =>
    validateRegionalManifest({
      ...manifest,
      asteroids: { ...manifest.asteroids, samples: [...manifest.asteroids.samples, finalRock] },
    })
  ).toThrow();
  expect(() =>
    validateRegionalManifest({ ...manifest, counts: { ...manifest.counts, asteroids: 80 } })
  ).toThrow();
});

test('replacing a natural world with a fixed field disqualifies its regional receipt', () => {
  const engine = new GameEngine(42);
  engine.addPlayer('pilot', 'Pilot', new RecordingSocket());
  expect(captureRegionalManifest(engine, 42).field.mode).toBe('regional');
  engine.createAsteroids(80);
  expect(engine.getAsteroidFieldStatus().mode).toBe('fixture');
  expect(() => captureRegionalManifest(engine, 42)).toThrow('replaced by a fixture');
  expect(() => parseRegionalStatus(engine.getAsteroidFieldStatus())).toThrow('field mode changed');
});

test('a natural baseline rejects a pilot whose life epoch changed before readiness', () => {
  const requirement = {
    sequence: 10,
    gameTime: 100,
    motionEpoch: 1,
    requireExactMotionEpoch: true,
  };
  const observation = { lastKeyframeSequence: 10, lastSnapshotGameTime: 100, motionEpoch: 1 };
  expect(observesPreparedFixture(requirement, observation)).toBe(true);
  expect(observesPreparedFixture(requirement, { ...observation, motionEpoch: 2 })).toBe(false);
  expect(observesPreparedFixture(requirement, { ...observation, lastKeyframeSequence: 9 })).toBe(
    false
  );
  expect(observesPreparedFixture(requirement, { ...observation, lastSnapshotGameTime: 99 })).toBe(
    false
  );
  expect(
    observesPreparedFixture(
      { sequence: 10, gameTime: 100, motionEpoch: 1 },
      { ...observation, motionEpoch: 2 }
    )
  ).toBe(true);
});
