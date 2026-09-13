import { strict as assert } from 'node:assert';
import { describe, expect, test, vi } from 'vitest';
import {
  captureSnapshot,
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

describe('pilots reconstruct complete authoritative worlds', () => {
  test('compact world coordinates preserve precise ship handoffs, resources and future fields', () => {
    const world = snapshotFixture();
    const ship = world.entities[0];
    const asteroid = world.asteroids[0];
    assert.ok(ship && asteroid, 'ship and asteroid');
    ship.position = { x: 1.23456789, y: -2.34567891 };
    ship.velocity = { x: 0.00001234, y: -0.00002345 };
    ship.angle = 2 * Math.PI;
    ship.fuel = 45.12345678;
    ship.playerMotion = { epoch: 7, mode: 'handoff', ack: 101, anchor: ship.position };
    asteroid.position = Object.assign(
      { x: 1.23456789, y: -2.34567891 },
      {
        futureVector: { x: 0.123456789, y: 0.987654321 },
      }
    );
    asteroid.velocity = { x: 0.00001234, y: -0.00002345 };
    asteroid.rotation = 0.987654321;
    asteroid.angularVelocity = 0.000012345;
    asteroid.offsets = [0.123456789, 0.987654321];
    world.playerProjectiles = [
      {
        id: 'precise-shot',
        ownerId: ship.id,
        position: { x: 12.3456789, y: -12.3456789 },
        prevPosition: { x: 1.23456789, y: -1.23456789 },
        velocity: { x: 11.11111101, y: -11.11111101 },
        age: 2,
        bounces: 1,
        energy: 1.23456789,
      },
    ];
    const original = structuredClone(world);
    expect(captureSnapshot(world)).toEqual(original);
    const encoder = new SnapshotEncoder(world);
    const decoder = new SnapshotDecoder();
    const applied = decodeSnapshotMessage(decoder, encoder.encodeSerialized(1, undefined, 0).text);
    expect(world).toEqual(original);
    expect(applied.entities).toEqual(original.entities);
    expect(applied.asteroids[0]).toEqual({
      ...original.asteroids[0],
      position: {
        x: 1.2346,
        y: -2.3457,
        futureVector: { x: 0.123456789, y: 0.987654321 },
      },
      velocity: { x: 0, y: 0 },
      rotation: 0.9877,
    });
    expect(applied.playerProjectiles[0]).toEqual({
      ...original.playerProjectiles[0],
      position: { x: 12.3457, y: -12.3457 },
      prevPosition: { x: 1.2346, y: -1.2346 },
      velocity: { x: 11.1111, y: -11.1111 },
    });

    const appliedAsteroid = applied.asteroids[0];
    const appliedShip = applied.entities[0];
    assert.ok(appliedAsteroid && appliedShip, 'decoded actors');
    appliedAsteroid.position.x = 900;
    appliedShip.position.x = 900;
    asteroid.position.x = 1.23456781; // Same wire cell: a delta can omit this change.
    const next = new SnapshotEncoder(world);
    expect(
      decodeSnapshotMessage(
        decoder,
        snapshotMessage(next.encode(2, { sequence: 1, state: encoder.state }))
      )
    ).toEqual(JSON.parse(JSON.stringify(next.state)));
    expect(next.state.entities).toEqual(original.entities);
    expect(next.state.asteroids[0]?.position.x).toBe(1.2346);
  });

  test('large finite coordinates survive compact snapshots and invalid numbers still fail', () => {
    const world = snapshotFixture();
    const asteroid = world.asteroids[0];
    assert.ok(asteroid, 'asteroid');
    for (const value of [
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      902_000_000_000.125,
      -902_000_000_000.125,
    ]) {
      asteroid.position.x = value;
      const encoder = new SnapshotEncoder(world);
      expect(
        decodeSnapshotMessage(new SnapshotDecoder(), snapshotMessage(encoder.encode(1)))
          .asteroids[0]?.position.x
      ).toBe(value);
      expect(asteroid.position.x).toBe(value);
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      asteroid.position.x = value;
      expect(() => new SnapshotEncoder(world)).toThrow(/Non-JSON/);
      expect(Object.is(asteroid.position.x, value)).toBe(true);
    }
  });

  test('moving ticks preserve the wire world, effect clears, removal, death and respawn', () => {
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
        const pickup = world.satellitePickups[0];
        assert.ok(pickup, 'snapshot pickup');
        pickup.state = 'broken';
        pickup.health = 0;
        pickup.ownerId = null;
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
        expect(decodeSnapshotMessage(pilot.decoder, snapshotMessage(frame))).toEqual(
          JSON.parse(JSON.stringify(encoder.state))
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
    const first = new SnapshotEncoder(a);
    const next = new SnapshotEncoder(b);
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    const delta = next.encode(2, { sequence: 1, state: first.state });
    expect(delta.kind).toBe('delta');
    const decoded = decodeSnapshotMessage(decoder, snapshotMessage(delta));
    expect(decoded).toEqual(next.state);
    const decodedEntity = decoded.entities[0];
    assert.ok(decodedEntity, 'decoded entity');
    expect(Object.hasOwn(decodedEntity, 'harpoonTargetId')).toBe(false);
  });

  test('bad packets leave the last baseline intact and a fresh keyframe repairs gaps', () => {
    const decoder = new SnapshotDecoder();
    const state = captureSnapshot(snapshotFixture());
    const first = new SnapshotEncoder(state);
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    const next = captureSnapshot(snapshotFixture(1));
    const nextEncoder = new SnapshotEncoder(next);
    const delta = nextEncoder.encode(2, { sequence: 1, state: first.state });
    expect(() =>
      decodeSnapshotMessage(decoder, snapshotMessage({ ...delta, sequence: 3 }))
    ).toThrow(/baseline/);
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        JSON.stringify({
          type: 'snapshot',
          data: {
            version: 1,
            sequence: 2,
            kind: 'delta',
            baseline: 1,
            patch: {
              set: {},
              clear: [],
              collections: {
                entities: {
                  add: [],
                  update: [['pilot-0', { health: 'invalid' }, []]],
                  remove: [],
                },
              },
            },
          },
        })
      )
    ).toThrow(/DTO/);
    const invalidReference = captureSnapshot(snapshotFixture(2));
    const collabTag = invalidReference.collabTags[0];
    assert.ok(collabTag, 'collab tag');
    collabTag.asteroidId = 'missing-asteroid';
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        snapshotMessage({ version: 1, sequence: 2, kind: 'keyframe', state: invalidReference })
      )
    ).toThrow(/references/);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(delta))).toEqual(nextEncoder.state);
    expect(() => decodeSnapshotMessage(decoder, snapshotMessage(delta))).toThrow(/Stale/);
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        '{"type":"snapshot","data":{"version":1,"sequence":3,"kind":"delta","baseline":2,"patch":{"set":{"__proto__":{"polluted":true}},"clear":[],"collections":{}}}}'
      )
    ).toThrow(/Unsafe/);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(first.encode(50)))).toEqual(first.state);
    decoder.reset();
    expect(() => decodeSnapshotMessage(decoder, snapshotMessage(delta))).toThrow(/baseline/);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)))).toEqual(first.state);
  });

  test('sequence digit changes choose the smaller frame and ties send the complete world', () => {
    const world = {
      entities: [],
      asteroids: [],
      loot: [],
      satellitePickups: [],
      playerProjectiles: [],
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
        decodeSnapshotMessage(decoder, snapshotMessage(baseline.encode(baselineSequence)));
        expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(world);

        const serialized = encoder.encodeSerialized(
          recipientSequence,
          { sequence: baselineSequence, state: baseline.state },
          0
        );
        expect(serialized.frame).toEqual(frame);
        expect(serialized.text).toBe(
          JSON.stringify({ type: 'snapshot', data: serialized.frame, timestamp: 0 })
        );
      }
    }
  });

  test('serialized keyframes and deltas stay exact after source and consumer mutations', () => {
    const source = snapshotFixture();
    const encoder = new SnapshotEncoder(source);
    const first = encoder.encodeSerialized(1, undefined, 1234);
    expect(first.text).toBe(
      JSON.stringify({ type: 'snapshot', data: first.frame, timestamp: 1234 })
    );

    const sourceEntity = source.entities[0];
    const capturedEntity = encoder.state.entities[0];
    assert.ok(sourceEntity && capturedEntity, 'snapshot entity');
    sourceEntity.position.x = -900;
    expect(capturedEntity.position.x).toBe(500);

    const decoder = new SnapshotDecoder();
    const applied = decodeSnapshotMessage(decoder, first.text);
    const appliedEntity = applied.entities[0];
    assert.ok(appliedEntity, 'decoded entity');
    appliedEntity.position.x = -800;
    expect(capturedEntity.position.x).toBe(500);

    const nextState = snapshotFixture(1);
    const next = new SnapshotEncoder(nextState);
    const delta = next.encodeSerialized(2, { sequence: 1, state: encoder.state }, 1234);
    expect(delta.frame.kind).toBe('delta');
    expect(delta.text).toBe(
      JSON.stringify({ type: 'snapshot', data: delta.frame, timestamp: 1234 })
    );
    expect(decodeSnapshotMessage(decoder, delta.text)).toEqual(next.state);
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
    const applied = decodeSnapshotMessage(decoder, snapshotMessage(encoder.encode(1)));
    const appliedEntity = applied.entities[0];
    assert.ok(appliedEntity, 'applied entity');
    appliedEntity.position.x = -800;
    expect(encoder.state.entities[0]?.position.x).toBe(500);
    const changed = snapshotFixture();
    changed.gameTime = 1;
    const next = new SnapshotEncoder(changed);
    expect(
      decodeSnapshotMessage(
        decoder,
        snapshotMessage(next.encode(2, { sequence: 1, state: encoder.state }))
      )
    ).toEqual(next.state);
  });

  test('one parser call owns the envelope and snapshot admission', () => {
    const decoder = new SnapshotDecoder();
    const frame = new SnapshotEncoder(snapshotFixture()).encode(1);
    const text = snapshotMessage(frame);
    const parse = vi.spyOn(JSON, 'parse');

    const result = decoder.readMessage(text, { acceptSnapshots: true });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(text);
    expect(result).toMatchObject({
      kind: 'snapshot',
      metadata: { kind: 'keyframe', sequence: 1 },
    });
  });

  test('rejected admission does not retain a baseline and non-snapshots stay messages', () => {
    const decoder = new SnapshotDecoder();
    const state = snapshotFixture();
    const encoder = new SnapshotEncoder(state);
    const keyframe = snapshotMessage(encoder.encode(1));
    const rejected = decoder.readMessage(keyframe, { acceptSnapshots: false });
    expect(rejected).toMatchObject({
      kind: 'snapshot-rejected',
      error: expect.objectContaining({ message: expect.stringMatching(/before.*join ack/) }),
      metadata: { kind: 'keyframe', sequence: 1 },
    });

    expect(decodeSnapshotMessage(decoder, keyframe)).toEqual(
      JSON.parse(JSON.stringify(encoder.state))
    );
    expect(
      decoder.readMessage('{"type":"status","data":{"ready":true}}', {
        acceptSnapshots: true,
      })
    ).toEqual({ kind: 'message', message: { type: 'status', data: { ready: true } } });
  });
});
