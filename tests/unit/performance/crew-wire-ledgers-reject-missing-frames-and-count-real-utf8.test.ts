// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { canonicalJson } from '../../../benchmarks/results';
import { parseArguments } from '../../../benchmarks/run';
import { sampleOptions } from '../../../benchmarks/sample';
import {
  partitionSnapshotBytes,
  replayWireLedger,
  websocketTextHeaderBytes,
} from '../../../benchmarks/wire-ledger';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { snapshotFixture } from '../network/snapshotFixture';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function wireScene() {
  const world = snapshotFixture(0);
  world.mapAssets = [
    { id: 'cargo-1', kind: 'wreckage', position: { x: 10, y: 20 }, name: '基地 🚀' },
  ];
  world.spiderField = {
    spiders: Array.from({ length: 8 }, (_, index) => ({
      id: `spider-${index + 1}`,
      position: { x: 3200 + index * 70, y: 1000 },
      angle: 0,
      health: 25,
      maxHealth: 25,
      phase: 'scuttling' as const,
      targetId: null,
    })),
    nests: [],
  };
  const first = new SnapshotEncoder(world);
  const keyframe = first.encodeSerialized(1, undefined, 1000);
  const moving = structuredClone(world);
  const rock = moving.asteroids[0];
  const spider = moving.spiderField?.spiders[0];
  const asset = moving.mapAssets[0];
  if (!rock || !spider || !asset) {
    throw new Error('Declared wire scene is missing rows');
  }
  moving.gameTime = 1;
  rock.rotation = 0.5678;
  rock.position.x += 0.1234;
  spider.position.x += 1;
  asset.name = '基地 🚀 updated';
  // A generic neighbor update keeps these small motion tuples cheaper in JSON;
  // the separate dense-drift case below covers actual packed-property bytes.
  const damagedRock = moving.asteroids[1];
  const damagedSpider = moving.spiderField?.spiders[1];
  if (!damagedRock || !damagedSpider) {
    throw new Error('Declared wire scene is missing damaged neighbors');
  }
  damagedRock.health -= 1;
  damagedSpider.health -= 1;
  // Collection churn must retain the complete new order in the actual encoding.
  moving.asteroids.push(moving.asteroids.shift() ?? rock);
  const second = new SnapshotEncoder(moving);
  const delta = second.encodeSerialized(2, { sequence: 1, state: first.state }, 1033);
  expect(delta.frame.kind).toBe('delta');
  return { keyframe, delta, second };
}

function capture(text: string, decoder: SnapshotDecoder) {
  const decoded = decoder.readMessage(text, { acceptSnapshots: true });
  if (decoded.kind !== 'snapshot') {
    throw new Error('Expected an actual decoded snapshot');
  }
  const partition = partitionSnapshotBytes(text);
  const stateHash = hash(canonicalJson(decoded.state));
  return {
    pilot: 'wire-pilot-0',
    tick: decoded.state.gameTime,
    measured: true,
    text,
    payloadBytes: Buffer.byteLength(text, 'utf8'),
    websocketHeaderBytes: websocketTextHeaderBytes(Buffer.byteLength(text, 'utf8')),
    rawSha256: hash(text),
    type: 'snapshot',
    snapshot: {
      ...partition,
      decodedSha256: stateHash,
      expectedSha256: stateHash,
      normalizedStateSha256: stateHash,
      rows: {},
      activeScan: false,
    },
  };
}

test('crew movement, changing global spiders and Unicode map names account for every emitted byte', () => {
  const { keyframe, delta, second } = wireScene();
  const initial = partitionSnapshotBytes(keyframe.text);
  const changed = partitionSnapshotBytes(delta.text);
  for (const [text, partition] of [
    [keyframe.text, initial],
    [delta.text, changed],
  ] as const) {
    expect(Object.values(partition.parts).reduce((sum, count) => sum + count, 0)).toBe(
      Buffer.byteLength(text, 'utf8')
    );
    expect(partition.parts['containers-and-punctuation']).toBeGreaterThan(0);
  }
  expect(initial.payloadBytes).toBeGreaterThan(keyframe.text.length);
  expect(changed.parts['collections.asteroids.update.motion.rotation']).toBeGreaterThan(0);
  expect(changed.parts['collections.asteroids.update.references']).toBeGreaterThan(0);
  expect(changed.parts['collections.asteroids.order']).toBeGreaterThan(0);
  expect(changed.parts['collections.mapAssets.update.set.name']).toBeGreaterThan(0);
  expect(changed.parts['objects.spiderField.collections.spiders.update.motion.position']).toBe(
    Buffer.byteLength('100000', 'utf8')
  );
  expect(changed.parts['delta.set.spiderField']).toBeUndefined();
  expect(second.state.spiderField?.spiders).toHaveLength(8);
  expect(changed.parts['state.asteroids']).toBeUndefined();
  expect(() => partitionSnapshotBytes(`${delta.text}\n`)).toThrow('canonical');
  expect(websocketTextHeaderBytes(125)).toBe(2);
  expect(websocketTextHeaderBytes(126)).toBe(4);
  expect(websocketTextHeaderBytes(65535)).toBe(4);
  expect(websocketTextHeaderBytes(65536)).toBe(10);
  expect(() => websocketTextHeaderBytes(-1)).toThrow();
});

test('captured crew streams reject missing baselines, duplicate frames and altered decoded outcomes', () => {
  const { keyframe, delta } = wireScene();
  const decoder = new SnapshotDecoder();
  const frames = [capture(keyframe.text, decoder), capture(delta.text, decoder)];
  const first = frames[0];
  if (!first) {
    throw new Error('Missing initial keyframe');
  }
  expect(replayWireLedger(frames)).toBe(2);
  expect(() => replayWireLedger(frames.slice(1))).toThrow();
  expect(() => replayWireLedger([first, ...frames])).toThrow();
  const changed = structuredClone(frames);
  const second = changed[1];
  if (!second) {
    throw new Error('Missing captured delta');
  }
  const envelope: unknown = JSON.parse(second.text);
  if (
    !record(envelope) ||
    !record(envelope['data']) ||
    !record(envelope['data']['patch']) ||
    !record(envelope['data']['patch']['collections']) ||
    !record(envelope['data']['patch']['collections']['asteroids'])
  ) {
    throw new Error('Captured movement lost its asteroid patch');
  }
  const updates = envelope['data']['patch']['collections']['asteroids']['update'];
  if (!Array.isArray(updates)) {
    throw new Error('Captured movement lost its asteroid updates');
  }
  const motion: unknown = updates.find(
    (update: unknown) => Array.isArray(update) && typeof update[1] === 'number' && update[1] & 2
  );
  if (!Array.isArray(motion) || typeof motion[1] !== 'number') {
    throw new Error('Captured movement lost its rotation tuple');
  }
  const angleIndex = 2 + (motion[1] & 1 ? 2 : 0);
  const angle: unknown = motion[angleIndex];
  if (typeof angle !== 'number') {
    throw new Error('Captured rotation lost its scalar');
  }
  motion[angleIndex] = motion[1] & 8 ? angle + 1 : Math.round(angle * 10_000 + 1) / 10_000;
  second.text = JSON.stringify(envelope);
  expect(second.text).not.toBe(delta.text);
  second.rawSha256 = hash(second.text);
  // Same byte widths and baseline: only the retained decoded-state witness can reject this.
  expect(second.payloadBytes).toBe(Buffer.byteLength(second.text, 'utf8'));
  expect(() => replayWireLedger(changed)).toThrow('changed state');
  const wrongPilot = structuredClone(frames);
  const misrouted = wrongPilot[1];
  if (!misrouted) {
    throw new Error('Missing routed delta');
  }
  misrouted.pilot = 'wire-pilot-1';
  expect(() => replayWireLedger(wrongPilot)).toThrow();
});

test('packed asteroid drift accounts for its actual base64 property and replays the complete world', () => {
  const world = snapshotFixture(0);
  const first = new SnapshotEncoder(world);
  const keyframe = first.encodeSerialized(1, undefined, 1000);
  const moving = structuredClone(world);
  moving.gameTime = 2;
  for (const rock of moving.asteroids.slice(0, 20)) {
    rock.position.x += 0.1234;
    rock.position.y -= 0.2345;
    rock.rotation += 0.0001;
  }
  const second = new SnapshotEncoder(moving);
  const delta = second.encodeSerialized(2, { sequence: 1, state: first.state }, 1033);
  expect(delta.frame.kind).toBe('delta');
  if (delta.frame.kind !== 'delta') {
    throw new Error('Packed drift did not produce a delta');
  }
  const motion = delta.frame.patch.collections?.['asteroids']?.motion;
  expect(motion).toBeTypeOf('string');
  const partition = partitionSnapshotBytes(delta.text);
  const bucket = 'collections.asteroids.update.motion.packed';
  expect(partition.parts[bucket]).toBe(
    Buffer.byteLength(`"motion":${JSON.stringify(motion)}`, 'utf8')
  );
  expect(Object.keys(partition.parts).filter((name) => name.includes('.update.motion.'))).toEqual([
    bucket,
  ]);
  expect(Object.values(partition.parts).reduce((sum, count) => sum + count, 0)).toBe(
    Buffer.byteLength(delta.text, 'utf8')
  );
  const decoder = new SnapshotDecoder();
  const frames = [capture(keyframe.text, decoder), capture(delta.text, decoder)];
  expect(replayWireLedger(frames)).toBe(2);
  const complete = new SnapshotDecoder();
  complete.readMessage(keyframe.text, { acceptSnapshots: true });
  const result = complete.readMessage(delta.text, { acceptSnapshots: true });
  expect(result.kind).toBe('snapshot');
  if (result.kind === 'snapshot') {
    expect(result.state).toEqual(second.state);
  }
});

test('wire byte diagnostics require one pinned revision and reject graphics or timing-comparison options', () => {
  expect(sampleOptions('wire-ledger').kind).toBe('wire-ledger');
  expect(parseArguments(['measure', 'wire-ledger', '--revision', 'HEAD']).kind).toBe('wire-ledger');
  expect(() =>
    parseArguments(['compare', 'wire-ledger', '--baseline', 'HEAD', '--candidate', 'HEAD'])
  ).toThrow('single-revision');
  expect(() => sampleOptions('wire-ledger', '42', 'touch-portrait')).toThrow('Only client');
  expect(() => sampleOptions('wire-ledger', '42', 'desktop', 'webgl2')).toThrow('Only client');
  expect(() =>
    sampleOptions('wire-ledger', '42', 'desktop', 'canvas', '1', false, 'scan-wide')
  ).toThrow('Only client');
});
