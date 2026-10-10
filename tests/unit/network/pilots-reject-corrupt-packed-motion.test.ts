import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { encodeRelativeMotion, readRelativeMotion } from '../../../shared/snapshotMotion';
import {
  captureSnapshot,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

function encodedBytes(...bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

test('packed motion retains both signs of every safe53 integer boundary and sparse prior ordinals', () => {
  const values = [
    0,
    1,
    -1,
    63,
    -63,
    64,
    -64,
    127,
    -127,
    128,
    -128,
    2 ** 31 - 1,
    -(2 ** 31),
    2 ** 32,
    -(2 ** 32),
    2 ** 48,
    -(2 ** 48),
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
  ];
  for (const value of values) {
    const inverse = value === 0 ? 0 : -value;
    const encoded = encodeRelativeMotion([
      [2048, 15, value, inverse, 0, 63, -64],
      [0, 10, value],
    ]);
    const decoded: number[][] = [];
    readRelativeMotion(encoded, 2049, true, (ordinal, mask, numbers) => {
      decoded.push([ordinal, mask, ...numbers]);
    });
    expect(decoded).toEqual([
      [0, 10, value],
      [2048, 15, value, inverse, 0, 63, -64],
    ]);
  }
  expect(
    encodeRelativeMotion([
      [0, 9, 1, -2],
      [1, 10, 0],
    ])
  ).toBe(encodedBytes(9, 2, 5, 10, 0));
  const nearLimit = encodeRelativeMotion([[0, 10, Number.MAX_SAFE_INTEGER]], () => [
    Number.MAX_SAFE_INTEGER - 1,
  ]);
  expect(nearLimit).toBe(encodedBytes(26, 2));
  const restored: number[][] = [];
  readRelativeMotion(
    nearLimit,
    1,
    true,
    (ordinal, mask, numbers) => {
      restored.push([ordinal, mask, ...numbers]);
    },
    () => [Number.MAX_SAFE_INTEGER - 1]
  );
  expect(restored).toEqual([[0, 10, Number.MAX_SAFE_INTEGER]]);
});

test('pilots reject noncanonical or truncated packed numbers without losing the prior world', () => {
  const source = snapshotFixture();
  const first = new SnapshotEncoder(source);
  const changing = structuredClone(source);
  const asteroid = changing.asteroids[0];
  assert(asteroid);
  asteroid.position.x = 0.0001;
  const next = new SnapshotEncoder(changing);
  const valid = next.encode(2, { sequence: 1, state: first.state });
  assert.equal(valid.kind, 'delta');
  expect(valid.patch.collections?.['asteroids']?.motion).toBeTypeOf('string');
  const invalid = [
    '',
    'CQIA ',
    'CQIA\n',
    'CQI_',
    'CQI',
    'C===',
    'CQIB==',
    'Ch==',
    'CQJ=',
    123,
    encodedBytes(8),
    encodedBytes(1),
    encodedBytes(10),
    encodedBytes(24),
    encodedBytes(16),
    encodedBytes(25, 0, 0), // Invalid or context-free predictions.
    encodedBytes(10, 1), // Signed negative zero.
    encodedBytes(138, 0, 0), // Overlong header.
    encodedBytes(10, 128, 0), // Overlong signed integer.
    encodedBytes(10, 128), // Truncated signed integer.
    encodedBytes(10, 128, 128, 128, 128, 128, 128, 128, 128, 0),
    encodedBytes(10, 254, 255, 255, 255, 255, 255, 255, 32), // Magnitude exceeds safe53.
    encodeRelativeMotion([[80, 10, 0]]),
    'AAAA'.repeat(1281), // More than 80 maximal-size records, rejected before allocation.
  ];
  for (const motion of invalid) {
    const decoder = new SnapshotDecoder();
    const exposed = decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    const observed = structuredClone(exposed);
    const rejected = decoder.readMessage(
      JSON.stringify({
        type: 'snapshot',
        data: {
          version: 3,
          sequence: 2,
          baseline: 1,
          kind: 'delta',
          patch: { collections: { asteroids: { motion } } },
        },
      }),
      { acceptSnapshots: true }
    );
    expect(rejected.kind).toBe('snapshot-rejected');
    expect(exposed).toEqual(observed);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
  }
});

test('pilots reject overlapping operations and invalid relative baselines after partial packed work', () => {
  const source = snapshotFixture();
  const rock = source.asteroids[1];
  const overflow = source.asteroids[0];
  assert(rock && overflow);
  overflow.position.x = 1;
  rock.position.x = Number.MAX_SAFE_INTEGER;
  const first = new SnapshotEncoder(source);
  const next = new SnapshotEncoder(snapshotFixture(1));
  const valid = next.encode(2, { sequence: 1, state: first.state });
  const firstMotion = encodeRelativeMotion([[0, 9, 1, 0]]);
  const patches = [
    { collections: { asteroids: { remove: [0], motion: firstMotion } } },
    { collections: { asteroids: { update: [[0, { health: 25 }]], motion: firstMotion } } },
    {
      collections: {
        asteroids: {
          motion: encodeRelativeMotion([
            [0, 9, 1, 0],
            [1, 9, 1, 0],
          ]),
        },
      },
    },
    {
      collections: {
        asteroids: { motion: encodeRelativeMotion([[0, 9, Number.MAX_SAFE_INTEGER, 0]]) },
      },
    },
    { collections: { entities: { motion: firstMotion } } },
    {
      objects: {
        spiderField: {
          collections: { spiders: { motion: encodeRelativeMotion([[0, 12, 1, 0]]) } },
        },
      },
    },
  ];
  for (const patch of patches) {
    const decoder = new SnapshotDecoder();
    const exposed = decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    const observed = structuredClone(exposed);
    expect(
      decoder.readMessage(
        JSON.stringify({
          type: 'snapshot',
          data: {
            version: 3,
            sequence: 2,
            baseline: 1,
            kind: 'delta',
            patch,
          },
        }),
        { acceptSnapshots: true }
      ).kind
    ).toBe('snapshot-rejected');
    expect(exposed).toEqual(observed);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
  }
  expect(() =>
    readRelativeMotion(encodeRelativeMotion([[0, 12, 1, 0]]), 1, false, () => {})
  ).toThrow();
});

test('packed asteroid drift coexists with unknown fields, clear operations, churn and exact ordering', () => {
  const source = snapshotFixture();
  const retained = source.asteroids[2];
  assert(retained);
  retained.surveyedBy = ['survey-pilot'];
  Object.assign(retained, { futureField: ['星🚀', 1.23456789] });
  const first = new SnapshotEncoder(source);
  const changed = structuredClone(source);
  const drift = changed.asteroids[0];
  const generic = changed.asteroids[2];
  const addition = changed.asteroids[3];
  assert(drift && generic && addition);
  drift.position.x = 0.0001;
  drift.position.y = -0.0002;
  // Several drifting rows make the extra packed property cheaper while the
  // generic clear, addition, removal and reversed order stay in the same patch.
  for (const rock of changed.asteroids.slice(4, 9)) {
    rock.position.x += 0.0001;
  }
  delete generic.surveyedBy;
  generic.position.x += 0.0001;
  changed.asteroids.splice(1, 1);
  changed.asteroids.push({ ...structuredClone(addition), id: 'packed-new-rock' });
  changed.asteroids.reverse();
  const next = new SnapshotEncoder(changed);
  const frame = next.encode(2, { sequence: 1, state: first.state });
  assert.equal(frame.kind, 'delta');
  const patch = frame.patch.collections?.['asteroids'];
  expect(patch?.motion).toBeTypeOf('string');
  expect(patch?.update?.find((tuple) => tuple[0] === 2)?.[2]).toEqual(['surveyedBy']);
  expect(patch?.remove).toEqual([1]);
  expect(patch?.order?.[0]).toBe(80);
  const decoder = new SnapshotDecoder();
  decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
  expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
});

test('pilots recover exact asteroid impulses and wrapped rotations after irregular skipped snapshot ticks', () => {
  const source = snapshotFixture();
  source.gameTime = 100;
  const rock = source.asteroids[0];
  assert(rock);
  rock.position = { x: 12345.6789, y: -9876.5432 };
  rock.velocity = { x: 0.1234, y: 0.5678 };
  rock.rotation = 6.28;
  rock.angularVelocity = 0.002;
  const decoder = new SnapshotDecoder();
  let before = new SnapshotEncoder(source);
  decodeSnapshotMessage(decoder, snapshotMessage(before.encode(1)));
  for (const [sequence, ticks] of [
    [2, 3],
    [3, 7],
  ]) {
    assert(sequence !== undefined && ticks !== undefined);
    const changing = captureSnapshot(before.state);
    changing.gameTime += ticks;
    const moving = changing.asteroids[0];
    assert(moving);
    assert(typeof moving.angularVelocity === 'number');
    moving.position.x += moving.velocity.x * ticks + (sequence === 3 ? 0.0005 : 0);
    moving.position.y += moving.velocity.y * ticks;
    moving.rotation = (moving.rotation + moving.angularVelocity * ticks) % (2 * Math.PI);
    if (sequence === 3) {
      moving.velocity.x += 0.0001;
    }
    const next = new SnapshotEncoder(changing);
    const frame = next.encode(sequence, { sequence: sequence - 1, state: before.state });
    assert.equal(frame.kind, 'delta');
    const motion = frame.patch.collections?.['asteroids']?.motion;
    assert(typeof motion === 'string');
    expect((Buffer.from(motion, 'base64')[0] ?? 0) & 16).toBe(16);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
    before = next;
  }
});

test('prediction rejects invalid elapsed ticks, spider targets, unsafe projections and unsafe restored deltas atomically', () => {
  const source = snapshotFixture();
  source.gameTime = 100;
  const rock = source.asteroids[0];
  assert(rock);
  rock.position = { x: 12345.6789, y: -9876.5432 };
  rock.velocity = { x: 0.1234, y: 0.5678 };
  source.spiderField = {
    spiders: [
      {
        id: 'unpredicted-spider',
        position: { x: 10, y: 20 },
        angle: 0,
        health: 25,
        maxHealth: 25,
        phase: 'scuttling',
        targetId: null,
      },
    ],
    nests: [],
  };
  const first = new SnapshotEncoder(source);
  const changed = structuredClone(source);
  changed.gameTime += 3;
  const moving = changed.asteroids[0];
  assert(moving);
  moving.position.x += moving.velocity.x * 3;
  moving.position.y += moving.velocity.y * 3;
  const next = new SnapshotEncoder(changed);
  const valid = next.encode(2, { sequence: 1, state: first.state });
  const predicted = encodedBytes(25, 0, 0);
  const patches = [
    { collections: { asteroids: { motion: predicted } } },
    { set: { gameTime: 100.5 }, collections: { asteroids: { motion: predicted } } },
    { set: { gameTime: 99 }, collections: { asteroids: { motion: predicted } } },
    {
      set: { gameTime: 103 },
      objects: { spiderField: { collections: { spiders: { motion: predicted } } } },
    },
  ];
  for (const patch of patches) {
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    expect(
      decoder.readMessage(
        JSON.stringify({
          type: 'snapshot',
          data: {
            version: 3,
            sequence: 2,
            baseline: 1,
            kind: 'delta',
            patch,
          },
        }),
        { acceptSnapshots: true }
      ).kind
    ).toBe('snapshot-rejected');
    expect(decodeSnapshotMessage(decoder, snapshotMessage(valid))).toEqual(next.state);
  }
  const max = Number.MAX_SAFE_INTEGER;
  const overflow = encodeRelativeMotion([[0, 10, max]]);
  const bytes = Buffer.from(overflow, 'base64');
  bytes[0] = 26;
  expect(() =>
    readRelativeMotion(
      bytes.toString('base64'),
      1,
      true,
      () => {},
      () => [1]
    )
  ).toThrow();
  expect(() =>
    readRelativeMotion(
      predicted,
      1,
      true,
      () => {},
      () => undefined
    )
  ).toThrow();
});

test('unsafe and unknown velocity references retain ordinary motion while large safe deltas remain exact', () => {
  for (const velocity of [
    { x: 1e308, y: 1e308 },
    { x: 0.1234, y: 0.5678, futureVelocity: true },
  ]) {
    const source = snapshotFixture();
    source.gameTime = 100;
    const rock = source.asteroids[0];
    assert(rock);
    rock.position = { x: 12345.6789, y: -9876.5432 };
    rock.velocity = velocity;
    const first = new SnapshotEncoder(source);
    const changed = structuredClone(source);
    changed.gameTime += 3;
    const moving = changed.asteroids[0];
    assert(moving);
    moving.position.x += 0.0001;
    const next = new SnapshotEncoder(changed);
    const frame = next.encode(2, { sequence: 1, state: first.state });
    assert.equal(frame.kind, 'delta');
    const motion = frame.patch.collections?.['asteroids']?.motion;
    assert(typeof motion === 'string');
    expect((Buffer.from(motion, 'base64')[0] ?? 0) & 16).toBe(0);
    const decoder = new SnapshotDecoder();
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    expect(decodeSnapshotMessage(decoder, snapshotMessage(frame))).toEqual(next.state);
    expect(
      decoder.readMessage(
        JSON.stringify({
          type: 'snapshot',
          data: {
            version: 3,
            sequence: 3,
            baseline: 2,
            kind: 'delta',
            patch: {
              set: { gameTime: 106 },
              collections: { asteroids: { motion: encodedBytes(25, 0, 0) } },
            },
          },
        }),
        { acceptSnapshots: true }
      ).kind
    ).toBe('snapshot-rejected');
    const recovery = new SnapshotEncoder(next.state);
    expect(decodeSnapshotMessage(decoder, snapshotMessage(recovery.encode(3)))).toEqual(
      recovery.state
    );
  }
});
