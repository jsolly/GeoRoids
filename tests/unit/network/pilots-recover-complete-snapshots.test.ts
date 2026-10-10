import { strict as assert } from 'node:assert';
import { describe, expect, test, vi } from 'vitest';
import { emptySettlement } from '../../../shared/economy';
import { readRelativeMotion } from '../../../shared/snapshotMotion';
import {
  captureSnapshot,
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

const NON_JSON_ERROR_PATTERN = /Non-JSON/u;
const BASELINE_ERROR_PATTERN = /baseline/u;
const DTO_ERROR_PATTERN = /DTO/u;
const STALE_SNAPSHOT_ERROR_PATTERN = /Stale/u;
const UNSAFE_SNAPSHOT_ERROR_PATTERN = /Unsafe/u;
const JOIN_ACK_ORDER_ERROR_PATTERN = /before.*join ack/u;

function expandedUpdates(
  change:
    | { readonly update?: readonly (readonly unknown[])[]; readonly motion?: string }
    | undefined,
  maximum = 80,
  allowVelocity = true
): readonly (readonly unknown[])[] | undefined {
  if (!change) {
    return undefined;
  }
  const updates = [...(change.update ?? [])];
  if (change.motion !== undefined) {
    readRelativeMotion(change.motion, maximum, allowVelocity, (index, mask, values) => {
      updates.push([index, mask, ...values]);
    });
  }
  return updates.length
    ? updates.sort((left, right) => Number(left[0]) - Number(right[0]))
    : undefined;
}

describe('pilots reconstruct complete authoritative worlds', () => {
  test('compact world coordinates preserve precise ship handoffs, resources and future fields', () => {
    const world = snapshotFixture();
    const ship = world.entities[0];
    const asteroid = world.asteroids[0];
    assert.ok(ship && asteroid, 'ship and asteroid');
    ship.position = { x: 1.23456789, y: -2.34567891 };
    ship.velocity = { x: 0.00001234, y: -0.00002345 };
    ship.angle = 2 * Math.PI;
    ship.contourLock = { height: 0.24, direction: -1 };

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
      expect(() => new SnapshotEncoder(world)).toThrow(NON_JSON_ERROR_PATTERN);
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
      }
      if (tick < 20) {
        pilot.harpoonTargetId = 'asteroid-1';
        pilot.harpoonLatchPos = { x: 90, y: 60 };
      }
      if (tick >= 30 && tick < 60) {
        pilot.health = 0;
        pilot.exploding = true;
        pilot.respawnTimer = 60 - tick;
        pilot.deathCause = 'boundary';
      }

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
      for (const [index, pilotEntry] of pilots.entries()) {
        // One pilot stalls while the others receive newer baselines.
        if (index === 2 && tick >= 40 && tick < 46) {
          continue;
        }
        const sequence = pilotEntry.sequence++;
        const frame = encoder.encode(sequence, tick % 90 ? pilotEntry.baseline : undefined);
        if (frame.kind === 'delta') {
          deltas++;
        }
        expect(decodeSnapshotMessage(pilotEntry.decoder, snapshotMessage(frame))).toEqual(
          JSON.parse(JSON.stringify(encoder.state))
        );
        pilotEntry.baseline = { sequence, state: encoder.state };
      }
    }
    expect(deltas).toBeGreaterThan(300);
  });

  test('explicit clears delete fields and nested arrays replace without retaining stale values', () => {
    const a = captureSnapshot(snapshotFixture());
    const firstAEntity = a.entities[0];
    assert.ok(firstAEntity, 'first baseline entity');
    firstAEntity.contourLock = { height: 0.24, direction: 1 };
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
    expect(Object.hasOwn(decodedEntity, 'contourLock')).toBe(false);
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
    ).toThrow(BASELINE_ERROR_PATTERN);
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        JSON.stringify({
          type: 'snapshot',
          data: {
            version: 3,
            sequence: 2,
            kind: 'delta',
            baseline: 1,
            patch: {
              set: {},
              clear: [],
              collections: {
                entities: {
                  add: [],
                  update: [[0, { health: 'invalid' }]],
                  remove: [],
                },
              },
            },
          },
        })
      )
    ).toThrow(DTO_ERROR_PATTERN);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(delta))).toEqual(nextEncoder.state);
    expect(() => decodeSnapshotMessage(decoder, snapshotMessage(delta))).toThrow(
      STALE_SNAPSHOT_ERROR_PATTERN
    );
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        '{"type":"snapshot","data":{"version":3,"sequence":3,"kind":"delta","baseline":2,"patch":{"set":{"__proto__":{"polluted":true}},"clear":[],"collections":{}}}}'
      )
    ).toThrow(UNSAFE_SNAPSHOT_ERROR_PATTERN);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(first.encode(50)))).toEqual(first.state);
    decoder.reset();
    expect(() => decodeSnapshotMessage(decoder, snapshotMessage(delta))).toThrow(
      BASELINE_ERROR_PATTERN
    );
    expect(decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)))).toEqual(first.state);
  });

  test('sequence digit changes choose the smaller frame and ties send the complete world', () => {
    for (const nonAscii of [
      '\u0080\u07ff\u0800\uffff',
      '星🚀\n"pilot"',
      '\ud800 lone high \udc00 lone low',
      '🚀🚀 paired \ud800\ud800🚀\udc00',
    ]) {
      // Keep Unicode on only one side of each comparison. Matching Unicode in
      // both frames would let an incorrect UTF-16 character count cancel out.
      for (const [announcement, retiredPrefix] of [
        [nonAscii, 'retired'],
        ['ASCII pilot', `retired${nonAscii}`],
      ] as const) {
        const world = {
          entities: [],
          asteroids: [],
          loot: [],
          satellitePickups: [],
          playerProjectiles: [],
          settlement: emptySettlement(),
          exploration: [],
          mapAssets: [],
          gameTime: 1,
          isPaused: false,
          terrainSeed: 2345,
          futureAnnouncement: announcement,
        };
        for (const shorterBaseline of [9, 99]) {
          const sequence = shorterBaseline + 2;
          const full = { version: 3, sequence, kind: 'keyframe', state: world };
          const clear: string[] = [retiredPrefix];
          const delta = {
            version: 3,
            sequence,
            kind: 'delta',
            baseline: shorterBaseline + 1,
            patch: { clear },
          };
          // A retired future field makes the two complete wire frames exactly equal.
          const padding =
            Buffer.byteLength(JSON.stringify(full), 'utf8') -
            Buffer.byteLength(JSON.stringify(delta), 'utf8');
          expect(padding).toBeGreaterThan(0);
          const retired = `${retiredPrefix}${'x'.repeat(padding)}`;
          delta.patch.clear = [retired];
          expect(Buffer.byteLength(JSON.stringify(delta), 'utf8')).toBe(
            Buffer.byteLength(JSON.stringify(full), 'utf8')
          );
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
      }
    }
  });

  test('moving global spiders serialize the chosen nested patch once and reuse its exact wire text', () => {
    const world = snapshotFixture();
    world.spiderField = {
      spiders: Array.from({ length: 8 }, (_, index) => ({
        id: `serialization-spider-${index}`,
        position: { x: 100 + index, y: 200 },
        angle: 0,
        health: 25,
        maxHealth: 25,
        phase: 'scuttling' as const,
        targetId: null,
      })),
      nests: [],
    };
    const first = new SnapshotEncoder(world);
    const moving = structuredClone(world);
    const spider = moving.spiderField?.spiders[0];
    assert.ok(spider);
    spider.position.x += 1;
    const next = new SnapshotEncoder(moving);
    const baseline = { sequence: 1, state: first.state };
    const stringify = vi.spyOn(JSON, 'stringify');
    let frame: ReturnType<SnapshotEncoder['encode']>;
    let serialized: ReturnType<SnapshotEncoder['encodeSerialized']>;
    try {
      frame = next.encode(2, baseline);
      assert.equal(frame.kind, 'delta');
      expect(frame.patch.objects?.spiderField.collections?.['spiders']?.update).toEqual([
        [0, 1, 101, 200],
      ]);
      const selected = frame.patch;
      // Observe actual serialization work at the native boundary, not a mirrored
      // counter: discarding the selected candidate would serialize this twice.
      expect(stringify.mock.calls.filter(([value]) => value === selected)).toHaveLength(1);
      serialized = next.encodeSerialized(2, baseline, 1234);
      expect(stringify.mock.calls.filter(([value]) => value === selected)).toHaveLength(1);
    } finally {
      stringify.mockRestore();
    }
    expect(serialized.frame).toEqual(frame);
    expect(serialized.text).toBe(
      JSON.stringify({ type: 'snapshot', data: frame, timestamp: 1234 })
    );
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, first.encodeSerialized(1, undefined, 1000).text);
    expect(decodeSnapshotMessage(decoder, serialized.text)).toEqual(next.state);
  });

  test('small drifting updates avoid serializing complete worlds while future JSON survives', () => {
    const sparse: Array<null> = Array(3);
    sparse[1] = null;
    const world = Object.assign(snapshotFixture(), {
      futureAnnouncement: '星🚀\n"pilot"\ud800',
      futureFields: { absent: undefined, empty: '', zero: -0, enabled: false, value: null, sparse },
    });
    const first = new SnapshotEncoder(world);
    const changing = structuredClone(world);
    changing.gameTime = 2;
    for (const rock of changing.asteroids) {
      rock.position.x += 0.2;
      rock.position.y -= 0.4;
      rock.rotation += 0.004;
    }
    const next = new SnapshotEncoder(changing);
    const stringify = vi.spyOn(JSON, 'stringify');
    let encoded: ReturnType<SnapshotEncoder['encodeSerialized']>;
    try {
      encoded = next.encodeSerialized(2, { sequence: 1, state: first.state }, 1234);
      assert.equal(encoded.frame.kind, 'delta');
      expect(stringify.mock.calls.some(([value]) => value === next.state)).toBe(false);
      expect(
        stringify.mock.calls.some(
          ([value]) =>
            value !== null &&
            typeof value === 'object' &&
            'set' in value &&
            (value.set as { asteroids?: unknown } | undefined)?.asteroids === next.state.asteroids
        )
      ).toBe(false);
      expect(encoded.frame.patch.set?.['loot']).toBeUndefined();
      expect(encoded.frame.patch.collections?.['loot']).toBeUndefined();
    } finally {
      stringify.mockRestore();
    }
    expect(encoded.text).toBe(
      JSON.stringify({ type: 'snapshot', data: encoded.frame, timestamp: 1234 })
    );
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, first.encodeSerialized(1, undefined, 1000).text);
    expect(decodeSnapshotMessage(decoder, encoded.text)).toEqual(
      JSON.parse(JSON.stringify(next.state))
    );
    expect(world.futureFields.absent).toBeUndefined();
    expect(Object.is(world.futureFields.zero, -0)).toBe(true);
  });

  test('crew motion uses prior ordinals while churn and rearrangement preserve exact asteroid order', () => {
    const source = snapshotFixture();
    const first = new SnapshotEncoder(source);
    const changing = structuredClone(source);
    const a = changing.asteroids[0],
      b = changing.asteroids[1],
      c = changing.asteroids[2],
      addedSource = changing.asteroids[3];
    assert.ok(a && b && c && addedSource);
    a.position = { x: 12.34567, y: -8.76543 };
    a.rotation = 0.76543;
    a.velocity = { x: 0.54321, y: -0.65432 };
    b.position.x += 3;
    b.health = 20;
    c.position = Object.assign(
      { x: 10.00001, y: 20.00002 },
      { futureVector: { x: 0.123456789, y: 0.987654321 } }
    );
    const addition = { ...addedSource, id: 'new-deposit' };
    changing.asteroids.splice(3, 1);
    changing.asteroids.push(addition);
    const fourth = changing.asteroids.splice(3, 1)[0];
    assert.ok(fourth);
    changing.asteroids.unshift(fourth);
    const next = new SnapshotEncoder(changing);
    const frame = next.encode(2, { sequence: 1, state: first.state });
    assert.equal(frame.kind, 'delta');
    const patch = frame.patch.collections?.['asteroids'];
    assert.ok(patch);
    expect(patch.remove).toEqual([3]);
    expect(patch.add?.map((row) => row['id'])).toEqual(['new-deposit']);
    expect(patch.order).toEqual([4, 0, 1, 2, ...Array.from({ length: 75 }, (_, i) => i + 5), 80]);
    expect(expandedUpdates(patch)?.find((row) => row[0] === 0)).toEqual([
      0, 15, 123457, -87654, 7654, 4432, -4543,
    ]);
    expect(typeof patch.update?.find((row) => row[0] === 1)?.[1]).toBe('object');
    expect(typeof patch.update?.find((row) => row[0] === 2)?.[1]).toBe('object');
    const decoder = new SnapshotDecoder();
    const applied = decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    applied.asteroids.reverse();
    applied.asteroids[0]?.offsets.push(99);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);

    const natural = structuredClone(source);
    natural.asteroids.splice(3, 1);
    natural.asteroids.push(addition);
    const naturalFrame = new SnapshotEncoder(natural).encode(2, {
      sequence: 1,
      state: first.state,
    });
    assert.equal(naturalFrame.kind, 'delta');
    const naturalPatch = naturalFrame.patch.collections?.['asteroids'];
    assert.ok(naturalPatch);
    expect(naturalPatch.order).toBeUndefined();
    expect(naturalPatch.update).toBeUndefined();
    expect(naturalFrame.patch.clear).toBeUndefined();
    const naturalDecoder = new SnapshotDecoder();
    decodeSnapshotMessage(naturalDecoder, snapshotMessage(first.encode(1)));
    expect(decodeSnapshotMessage(naturalDecoder, snapshotMessage(naturalFrame))).toEqual(
      new SnapshotEncoder(natural).state
    );
  });

  test('drifting asteroids reconstruct every absolute motion mask without changing precision', () => {
    const source = snapshotFixture();
    const unsafe = source.asteroids[0];
    assert.ok(unsafe);
    unsafe.position = { x: Number.MAX_SAFE_INTEGER, y: -Number.MAX_SAFE_INTEGER };
    unsafe.velocity = { x: Number.MAX_SAFE_INTEGER, y: -Number.MAX_SAFE_INTEGER };
    unsafe.rotation = Number.MAX_SAFE_INTEGER;
    const original = structuredClone(source);
    const first = new SnapshotEncoder(source);
    for (let mask = 1; mask <= 7; mask++) {
      const changing = structuredClone(source),
        rock = changing.asteroids[0];
      assert.ok(rock);
      const values: number[] = [];
      if (mask & 1) {
        rock.position = { x: 9.87654321, y: -8.7654321 };
        values.push(9.8765, -8.7654);
      }
      if (mask & 2) {
        rock.rotation = 0.7654321;
        values.push(0.7654);
      }
      if (mask & 4) {
        rock.velocity = { x: 0.54321098, y: -0.654321 };
        values.push(0.5432, -0.6543);
      }
      const next = new SnapshotEncoder(changing),
        frame = next.encode(2, { sequence: 1, state: first.state });
      assert.equal(frame.kind, 'delta');
      expect(frame.patch.collections?.['asteroids']?.update).toEqual([[0, mask, ...values]]);
      const decoder = new SnapshotDecoder();
      decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
      expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
      expect(source).toEqual(original);
    }
  });

  test('small asteroid drift retains precise signed motion through prior indices, reordered survivors and additions', () => {
    const source = snapshotFixture();
    const originalRock = source.asteroids[0];
    assert.ok(originalRock);
    originalRock.position = { x: 12345.6789, y: -9876.5432 };
    originalRock.velocity = { x: 123.4567, y: -987.6543 };
    originalRock.rotation = 6.2831;
    const before = new SnapshotEncoder(source);
    for (let mask = 1; mask <= 7; mask++) {
      const changing = structuredClone(source);
      const rock = changing.asteroids[0];
      assert.ok(rock);
      const deltas: number[] = [];
      if (mask & 1) {
        rock.position = { x: 12345.679, y: -9876.5434 };
        deltas.push(1, -2);
      }
      if (mask & 2) {
        rock.rotation = 6.283;
        deltas.push(-1);
      }
      if (mask & 4) {
        rock.velocity = { x: 123.4568, y: -987.6543 };
        deltas.push(1, 0);
      }
      changing.asteroids.splice(1, 1);
      changing.asteroids.push({ ...structuredClone(rock), id: `relative-add-${mask}` });
      changing.asteroids.reverse();
      const next = new SnapshotEncoder(changing);
      const frame = next.encode(2, { sequence: 1, state: before.state });
      assert.equal(frame.kind, 'delta');
      const patch = frame.patch.collections?.['asteroids'];
      expect(expandedUpdates(patch)).toEqual([[0, mask | 8, ...deltas]]);
      expect(patch?.remove).toEqual([1]);
      expect(patch?.order?.[0]).toBe(80);
      expect(patch?.order?.at(-1)).toBe(0);
      expect(patch?.add?.[0]?.['position']).toEqual(next.state.asteroids[0]?.position);
      const decoder = new SnapshotDecoder();
      const application = decodeSnapshotMessage(decoder, snapshotMessage(before.encode(1)));
      application.asteroids.reverse();
      const appRock = application.asteroids.at(-1);
      assert.ok(appRock);
      appRock.position.x = -100;
      expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
    }
  });

  test('motion byte ties and angle wrap retain absolute values while signed zero crossings remain exact', () => {
    const cases = [
      {
        before: { position: { x: -9.9999, y: 0 }, rotation: 0 },
        after: { position: { x: 0.0001, y: 0 }, rotation: 0 },
        absolute: [0, 1, 0.0001, 0],
        relative: [0, 9, 100000, 0],
        tie: true,
      },
      {
        before: { position: { x: 0, y: 0 }, rotation: -0.9999 },
        after: { position: { x: 0, y: 0 }, rotation: 0.0001 },
        absolute: [0, 2, 0.0001],
        relative: [0, 10, 10000],
        tie: true,
      },
      {
        before: { position: { x: 0, y: 0 }, rotation: 6.2831 },
        after: { position: { x: 0, y: 0 }, rotation: 0 },
        absolute: [0, 2, 0],
        relative: [0, 10, -62831],
        tie: false,
      },
      {
        before: { position: { x: -0.0001, y: 9876.5432 }, rotation: 0 },
        after: { position: { x: 0, y: 9876.5432 }, rotation: 0 },
        absolute: [0, 1, 0, 9876.5432],
        relative: [0, 9, 1, 0],
        tie: false,
      },
    ];
    for (const scenario of cases) {
      const source = snapshotFixture();
      const rock = source.asteroids[0];
      assert.ok(rock);
      Object.assign(rock, scenario.before);
      const before = new SnapshotEncoder(source);
      const changed = structuredClone(source);
      const moving = changed.asteroids[0];
      assert.ok(moving);
      Object.assign(moving, scenario.after);
      const next = new SnapshotEncoder(changed);
      const frame = next.encode(2, { sequence: 1, state: before.state });
      assert.equal(frame.kind, 'delta');
      const absoluteBytes = Buffer.byteLength(JSON.stringify(scenario.absolute), 'utf8');
      const relativeBytes = Buffer.byteLength(JSON.stringify(scenario.relative), 'utf8');
      if (scenario.tie) {
        expect(relativeBytes).toBe(absoluteBytes);
      }
      const expected = relativeBytes < absoluteBytes ? scenario.relative : scenario.absolute;
      expect(expandedUpdates(frame.patch.collections?.['asteroids'])).toEqual([expected]);
      const decoder = new SnapshotDecoder();
      decodeSnapshotMessage(decoder, snapshotMessage(before.encode(1)));
      expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
    }
  });

  test('non-P4 and unsafe baselines preserve absolute motion and reject invalid relative work before later recovery', () => {
    const baselines = [
      { x: 1.234567, y: 2 },
      { x: Number.MAX_SAFE_INTEGER, y: 2 },
      { x: 900719925474, y: 2 },
      { x: -900719925474, y: 2 },
      { x: 10, y: 20, futureVector: { x: 0.1234567, y: 0.7654321 } },
    ];
    for (const position of baselines) {
      const source = snapshotFixture();
      const rock = source.asteroids[0];
      assert.ok(rock);
      rock.position = structuredClone(position);
      const baseline = captureSnapshot(source);
      const changing = structuredClone(source);
      const moved = changing.asteroids[0];
      assert.ok(moved);
      moved.position = { x: 0.0001, y: 0 };
      const next = new SnapshotEncoder(changing);
      const valid = next.encode(2, { sequence: 1, state: baseline });
      assert.equal(valid.kind, 'delta');
      expect(valid.patch.collections?.['asteroids']?.update).toEqual([[0, 1, 0.0001, 0]]);
      for (const tuple of [
        [0, 8],
        [0, 16, 1, 2],
        [0, 9, 0.5, 0],
        [0, 9, Number.MAX_SAFE_INTEGER + 1, 0],
        [0, 9, position.x < 0 ? -1000 : 1000, 0],
        [0, 9, 1],
        [0, 9, 1, 2, 3],
      ]) {
        const decoder = new SnapshotDecoder();
        const keyframe = { version: 3, sequence: 1, kind: 'keyframe', state: baseline } as const;
        const app = decodeSnapshotMessage(decoder, snapshotMessage(keyframe));
        const original = structuredClone(app);
        const corrupt = {
          version: 3,
          sequence: 2,
          kind: 'delta',
          baseline: 1,
          patch: { collections: { asteroids: { update: [tuple] } } },
        };
        expect(
          decoder.readMessage(JSON.stringify({ type: 'snapshot', data: corrupt }), {
            acceptSnapshots: true,
          }).kind
        ).toBe('snapshot-rejected');
        expect(app).toEqual(original);
        expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
      }
    }
  });

  test('moving spiders retain global homes and unknown fields across nested patches and field removal', () => {
    const world = snapshotFixture();
    world.spiderField = {
      spiders: Array.from({ length: 24 }, (_, i) => ({
        id: `spider-${i}`,
        position: { x: 100 + i, y: 200 },
        angle: 0,
        health: 25,
        maxHealth: 25,
        phase: 'scuttling' as const,
        targetId: null,
      })),
      nests: Array.from({ length: 8 }, (_, i) => ({
        id: `${i},0`,
        resourceId: `home-${i}`,
        cleared: false,
        position: { x: i * 1000, y: 1000 },
      })),
    };
    Object.assign(world.spiderField, { futureSignal: { values: ['星🚀', true] } });
    const first = new SnapshotEncoder(world),
      changed = structuredClone(world);
    const spider = changed.spiderField?.spiders[0];
    assert.ok(spider);
    spider.position = { x: 123.45678, y: 234.56789 };
    spider.angle = 0.45678;
    const damaged = changed.spiderField?.spiders[1];
    assert.ok(damaged);
    damaged.position.x += 1;
    damaged.angle = 0.12345;
    damaged.health = 20;
    changed.spiderField?.nests.pop();
    const next = new SnapshotEncoder(changed),
      frame = next.encode(2, { sequence: 1, state: first.state });
    assert.equal(frame.kind, 'delta');
    expect(frame.patch.set?.['spiderField']).toBeUndefined();
    const updates = expandedUpdates(
      frame.patch.objects?.spiderField.collections?.['spiders'],
      24,
      false
    );
    expect(updates?.find((row) => row[0] === 0)).toEqual([0, 11, 234568, 345679, 4568]);
    expect(updates?.find((row) => row[0] === 1)).toEqual([
      1,
      { position: { x: 102, y: 200 }, angle: 0.1235, health: 20 },
    ]);
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
    const noSpiders = structuredClone(changed);
    delete noSpiders.spiderField;
    const gone = new SnapshotEncoder(noSpiders),
      removed = gone.encode(3, { sequence: 2, state: next.state });
    assert.equal(removed.kind, 'delta');
    expect(removed.patch.clear).toContain('spiderField');
    expect(removed.patch.objects).toBeUndefined();
    expect(decodeSnapshotMessage(decoder, snapshotMessage(removed))).toEqual(gone.state);
    const returned = next.encode(4, { sequence: 3, state: gone.state });
    assert.equal(returned.kind, 'delta');
    expect(returned.patch.set?.['spiderField']).toEqual(next.state.spiderField);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(returned))).toEqual(next.state);
  });

  test('pilots reject malformed ordinal and motion work without changing the accepted baseline', () => {
    const source = snapshotFixture();
    source.spiderField = {
      spiders: [
        {
          id: 'existing-spider',
          position: { x: 100, y: 200 },
          angle: 0,
          health: 25,
          maxHealth: 25,
          phase: 'scuttling',
          targetId: null,
        },
      ],
      nests: [],
    };
    const first = new SnapshotEncoder(source),
      changed = structuredClone(source);
    const rock = changed.asteroids[0];
    assert.ok(rock);
    rock.position = { x: 321.1234, y: -123.4567 };
    const next = new SnapshotEncoder(changed),
      valid = next.encode(2, { sequence: 1, state: first.state });
    assert.equal(valid.kind, 'delta');
    const corrupt: unknown[] = [
      { history: [] },
      { collections: { asteroids: { hidden: [] } } },
      { collections: { asteroids: { update: null } } },
      { collections: { asteroids: { remove: null } } },
      { collections: { asteroids: { add: null } } },
      ...[-1, 0.5, 80, Number.MAX_SAFE_INTEGER + 1].map((index) => ({
        collections: { asteroids: { update: [[index, 1, 1, 2]] } },
      })),
      {
        collections: {
          asteroids: {
            update: [
              [0, 1, 1, 2],
              [0, 2, 0.5],
            ],
          },
        },
      },
      { collections: { asteroids: { remove: [0, 0] } } },
      { collections: { asteroids: { remove: [0], update: [[0, 1, 1, 2]] } } },
      { collections: { asteroids: { remove: [0], add: [source.asteroids[0]] } } },
      { collections: { asteroids: { update: [[0, { id: 'different-rock' }]] } } },
      { collections: { asteroids: { update: [[0, { material: 'ice' }, ['material']]] } } },
      { collections: { asteroids: { update: [[0, {}, ['missing-field']]] } } },
      { collections: { asteroids: { update: [[0, {}, null]] } } },
      ...[0, -1, 0.5, 8].map((mask) => ({
        collections: { asteroids: { update: [[0, mask, 1, 2]] } },
      })),
      { collections: { asteroids: { update: [[0, 1, 1]] } } },
      { collections: { asteroids: { update: [[0, 1, 1, 2, {}]] } } },
      { collections: { asteroids: { update: [[0, 1, 1, 'not-a-number']] } } },
      { collections: { asteroids: { order: [0] } } },
      { collections: { asteroids: { order: Array(80).fill(0) } } },
      {
        collections: { asteroids: { remove: [0], order: Array.from({ length: 79 }, (_, i) => i) } },
      },
      { set: { asteroids: [] }, collections: { asteroids: {} } },
      { clear: ['asteroids'], collections: { asteroids: {} } },
      { objects: { futureFeature: {} } },
      { objects: { spiderField: { objects: {} } } },
      { set: { spiderField: source.spiderField }, objects: { spiderField: {} } },
      { clear: ['spiderField'], objects: { spiderField: {} } },
      { objects: { spiderField: { set: { spiders: [] }, collections: { spiders: {} } } } },
      { objects: { spiderField: { collections: { futureSpiders: {} } } } },
      { objects: { spiderField: { collections: { spiders: { update: [[0, 4, 1, 2]] } } } } },
      JSON.parse('{"set":{"constructor":true}}'),
    ];
    for (const patch of corrupt) {
      const decoder = new SnapshotDecoder();
      decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
      const rejected = decoder.readMessage(
        JSON.stringify({
          type: 'snapshot',
          data: { version: 3, sequence: 2, kind: 'delta', baseline: 1, patch },
        }),
        { acceptSnapshots: true }
      );
      expect(rejected.kind).toBe('snapshot-rejected');
      expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
    }
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    expect(
      decoder.readMessage(
        '{"type":"snapshot","data":{"version":3,"sequence":2,"kind":"delta","baseline":1,"patch":{"collections":{"asteroids":{"update":[[0,1,1e999,2]]}}}}}',
        { acceptSnapshots: true }
      ).kind
    ).toBe('snapshot-rejected');
    expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
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
      error: expect.objectContaining({
        message: expect.stringMatching(JOIN_ACK_ORDER_ERROR_PATTERN),
      }),
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
