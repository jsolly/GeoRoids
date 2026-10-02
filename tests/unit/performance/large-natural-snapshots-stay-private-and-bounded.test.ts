import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { LargeSnapshotEvidence } from '../../../benchmarks/large-snapshot-evidence';
import { regionalSnapshotWork } from '../../../benchmarks/regional-scan-workload';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from '../network/snapshotFixture';

function actualLargeFrame() {
  const state = snapshotFixture();
  const rocks = state.asteroids;
  state.asteroids = [
    ...rocks,
    ...Array.from({ length: 3 }, (_, batch) =>
      rocks.map((rock) => ({ ...rock, id: `${batch}-${rock.id}` }))
    ).flat(),
  ];
  const text = snapshotMessage(new SnapshotEncoder(state).encode(1));
  const actual = new SnapshotDecoder().readMessage(text, { acceptSnapshots: true });
  assert(actual.kind === 'snapshot');
  const work = regionalSnapshotWork(actual.state, actual.metadata, 'pilot-0');
  assert(work && Buffer.byteLength(text) >= 64 * 1024);
  return { text, metadata: { ...work, ownerId: 'pilot-0', measured: true } };
}

test('large actual natural frames retain exact payloads privately with explicit frame omissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'georoids-large-snapshots-'));
  try {
    const evidence = new LargeSnapshotEvidence();
    const { text, metadata } = actualLargeFrame();
    for (let i = 0; i < 35; i++) {
      evidence.offer(text, metadata);
    }
    const path = join(directory, 'frames.json');
    const receipt = await evidence.save(path);
    expect(receipt.candidateFrames).toBe(35);
    expect(receipt.retainedFrames).toBe(32);
    expect(receipt.omittedFrames).toBe(3);
    expect(receipt.omittedPayloadBytes).toBe(Buffer.byteLength(text) * 3);
    expect(receipt.artifactBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, 'utf8');
    const artifact = JSON.parse(raw);
    expect(artifact.frames[0].envelope).toEqual(JSON.parse(text));
    expect(artifact.frames[0].bytes).toBe(Buffer.byteLength(text));
    expect(artifact.frames[0].sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(receipt.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('large-frame capture exposes the byte ceiling and never retains private control credentials', () => {
  const evidence = new LargeSnapshotEvidence();
  const { text, metadata } = actualLargeFrame();
  const tooLarge = `{"type":"snapshot","data":{"padding":"${'x'.repeat(8 * 1024 * 1024)}"}}`;
  evidence.offer(tooLarge, metadata);
  evidence.offer(text, metadata);
  expect(evidence.report()).toMatchObject({
    candidateFrames: 2,
    retainedFrames: 0,
    omittedFrames: 2,
  });
  const controls = [
    `{"type":"joined","data":{"resumeToken":"${'x'.repeat(64 * 1024)}"}}`,
    `{"type":"snapshot","data":{"resumeToken":"${'x'.repeat(64 * 1024)}"}}`,
  ];
  for (const control of controls) {
    expect(() => evidence.offer(control, metadata)).toThrow('credential-free snapshot');
  }
  expect(evidence.report().candidateFrames).toBe(2);
});
