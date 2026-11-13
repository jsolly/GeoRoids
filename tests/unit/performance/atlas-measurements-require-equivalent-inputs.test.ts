/* @vitest-environment node */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { readAtlasFixture } from '../../../benchmarks/atlas-resync';
import { ownBenchmarkIdentity } from '../../../benchmarks/benchmark-identity';
import { compareAtlasResync } from '../../../benchmarks/compare-atlas-resync';
import { RNGService } from '../../../server/core/RNGService';
import { SatellitePickupManager } from '../../../server/core/SatellitePickupManager';

test('the controlled generation boundary preserves all six satellite IDs and complete rows', () => {
  const original = randomUUID;
  const create = () => {
    const identity = ownBenchmarkIdentity(82);
    try {
      return new SatellitePickupManager(new RNGService(82)).createPickups(6);
    } finally {
      identity.release();
    }
  };
  const before = create();
  const after = create();
  expect(before).toHaveLength(6);
  expect(after).toEqual(before);
  expect(new Set(before.map((row) => row.id)).size).toBe(6);
  for (const row of before) {
    expect(row.id).toMatch(
      /^server-pickup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  }
  expect(randomUUID).toBe(original);
});

test('the pinned atlas workload identifies 1200 exact tiles and an independently empty next bit', () => {
  const fixture = readAtlasFixture(
    fileURLToPath(new URL('../../../benchmarks/fixtures/atlas-resync-1200.json', import.meta.url))
  );
  expect(fixture.tiles).toHaveLength(1200);
  expect(fixture.tiles[0]).toEqual({ id: '0,0', bits: `01${'00'.repeat(31)}` });
  expect(fixture.tiles[1199]?.id).toBe('59,19');
  expect(fixture.reveal).toEqual({ x: -59812.5, y: -59937.5 });
  expect(new Set(fixture.tiles.map((tile) => tile.id)).size).toBe(1200);
});

test('comparison keeps cold-join totals separate and rejects changed fixtures or reconstructed state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-receipt-contract-'));
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  const names = ['initial-baseline', 'same-socket-unchanged-resync', 'same-socket-one-tile-resync'];
  const receipt = (atlas: number) => ({
    version: 1,
    fixtureSha256: '1'.repeat(64),
    harnessSha256: '2'.repeat(64),
    node: 'v26.13.1',
    windows: names.map((name) => ({
      name,
      completeWorldSha256: '3'.repeat(64),
      firstKeyframeBytes: 20,
      snapshotPayloadBytes: 100,
      atlasFieldBytes: name === 'same-socket-unchanged-resync' ? atlas : 10,
      snapshotFrames: 2,
      acknowledgementPayloadBytes: 60,
      framedDownstreamBytes: 104,
      framedAcknowledgementBytes: 72,
    })),
  });
  try {
    writeFileSync(before, JSON.stringify(receipt(40)));
    writeFileSync(after, JSON.stringify(receipt(0)));
    const comparison = compareAtlasResync(before, after);
    expect(comparison[1]?.delta['atlasFieldBytes']).toBe(-40);
    expect(comparison[0]?.after['snapshotPayloadBytes']).toBe(100);
    writeFileSync(after, JSON.stringify({ ...receipt(0), fixtureSha256: '4'.repeat(64) }));
    expect(() => compareAtlasResync(before, after)).toThrow('Fixture changed');
    const changed = receipt(0);
    const window = changed.windows[0];
    if (!window) {
      throw new Error('Missing receipt fixture');
    }
    window.completeWorldSha256 = '5'.repeat(64);
    writeFileSync(after, JSON.stringify(changed));
    expect(() => compareAtlasResync(before, after)).toThrow('Complete reconstructed world changed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
