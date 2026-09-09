import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';
import {
  captureSnapshot,
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { snapshotFixture } from './snapshotFixture';

describe('pilots reconstruct complete authoritative worlds', () => {
  test('moving ticks preserve every field, effect clears, removal, death and respawn', () => {
    const pilots: Array<{
      decoder: SnapshotDecoder;
      sequence: number;
      baseline?: SnapshotBaseline;
    }> = [1, 8, 98].map((sequence) => ({
      decoder: new SnapshotDecoder(),
      sequence,
    }));
    let deltas = 0;
    for (let tick = 0; tick < 140; tick++) {
      const world = snapshotFixture(tick);
      const pilot = world.entities[1];
      assert.ok(pilot, 'snapshot pilot');
      for (const ship of world.entities) {
        ship.abilityActiveFrames = tick < 25 ? 25 - tick : 0;
        ship.abilityCooldownFrames = tick < 50 ? 50 - tick : 0;
        ship.shieldTimer = tick < 10 ? 10 - tick : 0;
        ship.shieldCooldown = tick < 50 ? 50 - tick : 0;
      }
      if (tick < 20) {
        pilot.harpoonTargetId = 'asteroid-1';
        pilot.harpoonLatchPos = { x: 90, y: 60 };
        pilot.harpoonTimer = 30 - tick;
        pilot.shieldActive = true;
        pilot.shieldTime = 30 - tick;
      }
      if (tick >= 30 && tick < 60) {
        pilot.health = 0;
        pilot.exploding = true;
        pilot.lives = 2;
        pilot.respawnTimer = 60 - tick;
        pilot.deathCause = 'boundary';
      }
      pilot.fuel = tick < 70 ? 50 - tick / 2 : 80;
      if (tick >= 80) {
        world.entities.pop();
        world.loot = [];
      }
      if (tick >= 100) {
        world.asteroids = [];
      }
      if (tick >= 45 && tick < 65) {
        const satellite = world.satellites[0];
        assert.ok(satellite, 'snapshot satellite');
        satellite.exploding = true;
        satellite.health = 0;
        world.satelliteProjectiles = world.satelliteProjectiles.filter(
          (shot) => shot.satelliteId !== 'eo-0'
        );
      }
      if (tick === 25) {
        const asteroid = world.asteroids[0];
        assert.ok(asteroid, 'snapshot asteroid');
        asteroid.material = 'metal';
        asteroid.health = 25;
        asteroid.offsets = [1, 0.6, 1.1, 0.8];
        asteroid.vertices = 4;
      }
      if (tick >= 130) {
        world.satellites = [];
        world.satelliteProjectiles = [];
        world.satellitePickups = [];
      }
      // New fields and collections cannot be dropped by a stale codec whitelist.
      const extended = Object.assign(world, {
        futureFeature: { active: tick < 50, value: [tick, null] },
        futureNpcs: [{ id: 'eo', pattern: 'fan', shots: tick < 60 ? ['a', 'b'] : [] }],
      });
      const encoder = new SnapshotEncoder(extended);
      for (const [index, pilot] of pilots.entries()) {
        // One pilot stalls while the others receive newer baselines.
        if (index === 2 && tick >= 40 && tick < 46) {
          continue;
        }
        const sequence = pilot.sequence++;
        const frame = encoder.encode(sequence, tick % 90 ? pilot.baseline : undefined);
        if (frame.kind === 'delta') {
          deltas++;
        }
        expect(pilot.decoder.decode(JSON.parse(JSON.stringify(frame)))).toEqual(
          JSON.parse(JSON.stringify(extended))
        );
        pilot.baseline = { sequence, state: encoder.state };
      }
    }
    expect(deltas).toBeGreaterThan(300);
  });

  test('explicit clears delete fields and nested arrays replace without retaining stale values', () => {
    const a = captureSnapshot(snapshotFixture());
    const firstAEntity = a.entities[0];
    assert.ok(firstAEntity, 'first baseline entity');
    firstAEntity.harpoonTargetId = 'rock';
    firstAEntity.harpoonLatchPos = { x: 1, y: 2 };
    const b = captureSnapshot(snapshotFixture(1));
    const secondBaselineAsteroid = b.asteroids[0];
    assert.ok(secondBaselineAsteroid, 'second baseline asteroid');
    secondBaselineAsteroid.offsets = [0.2, 0.3];
    const decoder = new SnapshotDecoder();
    decoder.decode(new SnapshotEncoder(a).encode(1));
    const delta = new SnapshotEncoder(b).encode(2, { sequence: 1, state: a });
    expect(delta.kind).toBe('delta');
    const decoded = decoder.decode(delta);
    expect(decoded).toEqual(b);
    const decodedEntity = decoded.entities[0];
    assert.ok(decodedEntity, 'decoded entity');
    expect(Object.hasOwn(decodedEntity, 'harpoonTargetId')).toBe(false);
  });

  test('bad packets leave the last baseline intact and a fresh keyframe repairs gaps', () => {
    const decoder = new SnapshotDecoder();
    const state = captureSnapshot(snapshotFixture());
    decoder.decode(new SnapshotEncoder(state).encode(1));
    const next = captureSnapshot(snapshotFixture(1));
    const delta = new SnapshotEncoder(next).encode(2, { sequence: 1, state });
    expect(() => decoder.decode({ ...delta, sequence: 3 })).toThrow(/baseline/);
    expect(() =>
      decoder.decode({
        version: 1,
        sequence: 2,
        kind: 'delta',
        baseline: 1,
        patch: {
          set: {},
          clear: [],
          collections: {
            entities: { add: [], update: [['pilot-0', { health: 'invalid' }, []]], remove: [] },
          },
        },
      })
    ).toThrow(/DTO/);
    const invalidReference = captureSnapshot(snapshotFixture(2));
    const satelliteProjectile = invalidReference.satelliteProjectiles[0];
    assert.ok(satelliteProjectile, 'satellite projectile');
    satelliteProjectile.satelliteId = 'missing-eo';
    expect(() =>
      decoder.decode({ version: 1, sequence: 2, kind: 'keyframe', state: invalidReference })
    ).toThrow(/references/);
    expect(decoder.decode(delta)).toEqual(next);
    expect(() => decoder.decode(delta)).toThrow(/Stale/);
    expect(() =>
      decoder.decode(
        JSON.parse(
          '{"version":1,"sequence":3,"kind":"delta","baseline":2,"patch":{"set":{"__proto__":{"polluted":true}},"clear":[],"collections":{}}}'
        )
      )
    ).toThrow(/Unsafe/);
    expect(decoder.decode(new SnapshotEncoder(state).encode(50))).toEqual(state);
    decoder.reset();
    expect(() => decoder.decode(delta)).toThrow(/baseline/);
    expect(decoder.decode(new SnapshotEncoder(state).encode(1))).toEqual(state);
  });

  test('sequence digit changes choose the smaller frame and ties send the complete world', () => {
    const world = {
      entities: [],
      asteroids: [],
      loot: [],
      satellites: [],
      satellitePickups: [],
      satelliteProjectiles: [],
      collabTags: [],
      gameTime: 1,
      isPaused: false,
      terrainSeed: 2345,
      futureAnnouncement: '星🚀\n"pilot"',
    };
    for (const shorterBaseline of [9, 99]) {
      const sequence = shorterBaseline + 2;
      const full = { version: 1, sequence, kind: 'keyframe', state: world };
      const delta = {
        version: 1,
        sequence,
        kind: 'delta',
        baseline: shorterBaseline + 1,
        patch: { set: {}, clear: ['retired'], collections: {} },
      };
      // A retired future field makes the two complete wire frames exactly equal.
      const padding = JSON.stringify(full).length - JSON.stringify(delta).length;
      expect(padding).toBeGreaterThan(0);
      const retired = `retired${'x'.repeat(padding)}`;
      delta.patch.clear = [retired];
      expect(JSON.stringify(delta).length).toBe(JSON.stringify(full).length);
      const baseline = new SnapshotEncoder({ ...world, [retired]: true });
      const encoder = new SnapshotEncoder(world);
      for (const baselineSequence of [shorterBaseline, shorterBaseline + 1]) {
        const recipientSequence = baselineSequence + 1;
        const frame = encoder.encode(recipientSequence, {
          sequence: baselineSequence,
          state: baseline.state,
        });
        expect(frame).toEqual(
          baselineSequence === shorterBaseline
            ? { ...delta, sequence: recipientSequence, baseline: baselineSequence }
            : { ...full, sequence: recipientSequence }
        );
        const decoder = new SnapshotDecoder();
        decoder.decode(baseline.encode(baselineSequence));
        expect(decoder.decode(frame)).toEqual(world);
      }
    }
  });

  test('engine and application mutations never corrupt the other side of a baseline', () => {
    const engine = snapshotFixture();
    const encoder = new SnapshotEncoder(engine);
    const engineEntity = engine.entities[0];
    assert.ok(engineEntity, 'engine entity');
    engineEntity.position.x = -900;
    const encodedEntity = encoder.state.entities[0];
    assert.ok(encodedEntity, 'encoded entity');
    expect(encodedEntity.position.x).toBe(500);
    const decoder = new SnapshotDecoder();
    const applied = decoder.decode(JSON.parse(JSON.stringify(encoder.encode(1))));
    const appliedEntity = applied.entities[0];
    assert.ok(appliedEntity, 'applied entity');
    appliedEntity.position.x = -800;
    expect(encoder.state.entities[0]?.position.x).toBe(500);
    const changed = snapshotFixture();
    changed.gameTime = 1;
    const next = new SnapshotEncoder(changed);
    expect(decoder.decode(next.encode(2, { sequence: 1, state: encoder.state }))).toEqual(changed);
  });
});
