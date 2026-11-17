import { expect, test } from 'vitest';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { LootData } from '../../../shared-types';
import { LootField } from '../../../src/entities/loot/LootField';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

test('a snapshot v3 client displays cargo markers and rejects retired debris loot rows', () => {
  const field = new LootField();
  const cargo: LootData = {
    id: 'cargo',
    kind: 'points',
    position: { x: 2, y: 3 },
    mass: 0,
    radius: 12,
    points: 20,
  };
  const world = snapshotFixture();
  world.mapAssets = [{ id: 'cargo', kind: 'wreckage', name: 'Cargo', position: { x: 2, y: 3 } }];
  world.loot = [cargo];
  expect(() => validateSnapshotDto(world)).not.toThrow();
  field.applySnapshot(world.loot);
  expect(field.getAll()).toEqual([cargo]);
  expect(() =>
    validateSnapshotDto({ ...world, loot: [{ ...cargo, id: 'old-debris', kind: 'wreckage' }] })
  ).toThrow('Incomplete or invalid public snapshot DTO');
});

test('a snapshot v3 client rejects patches to the retired spider consumption collection', () => {
  const world = snapshotFixture();
  world.spiderField = Object.assign(world.spiderField ?? { spiders: [], nests: [] }, {
    consumed: [{ id: 'old-spider', position: { x: 2, y: 3 }, furnaceId: 'hearth', frame: 4 }],
  });
  const decoder = new SnapshotDecoder('diagnostic');
  decodeSnapshotMessage(decoder, snapshotMessage(new SnapshotEncoder(world).encode(1)));
  const consumed = { id: 'old-spider', position: { x: 2, y: 3 }, furnaceId: 'hearth', frame: 5 };
  expect(() =>
    decodeSnapshotMessage(
      decoder,
      snapshotMessage({
        version: 3,
        sequence: 2,
        kind: 'delta',
        baseline: 1,
        patch: {
          objects: { spiderField: { collections: { consumed: { update: [[0, consumed]] } } } },
        },
      })
    )
  ).toThrow('Invalid snapshot collection target');
});

test('a snapshot without a finite terrain seed is rejected instead of keeping a stale field', () => {
  const { terrainSeed: _terrainSeed, ...unseeded } = snapshotFixture();
  for (const world of [unseeded, { ...snapshotFixture(), terrainSeed: Number.NaN }]) {
    expect(() => validateSnapshotDto(world)).toThrow('Incomplete or invalid public snapshot DTO');
  }
});

test.each(['serverTime', 'civicModules', 'spiderField', 'beltRecovery'])(
  'pilots reject a missing required %s and recover with a complete keyframe',
  (field) => {
    const world = snapshotFixture();
    const missing = structuredClone(world);
    Reflect.deleteProperty(missing, field);
    expect(() => validateSnapshotDto(missing)).toThrow('Incomplete or invalid public snapshot DTO');
    expect(() => new SnapshotEncoder(missing)).toThrow();
    const decoder = new SnapshotDecoder('diagnostic');
    const first = new SnapshotEncoder(world);
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(1)));
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        JSON.stringify({
          type: 'snapshot',
          data: { version: 3, sequence: 2, kind: 'keyframe', state: missing },
        })
      )
    ).toThrow('Incomplete or invalid public snapshot DTO');
    decodeSnapshotMessage(decoder, snapshotMessage(first.encode(3)));
    expect(() =>
      decodeSnapshotMessage(
        decoder,
        snapshotMessage({
          version: 3,
          sequence: 4,
          kind: 'delta',
          baseline: 3,
          patch: { clear: [field] },
        })
      )
    ).toThrow('Incomplete or invalid public snapshot DTO');
    const next = new SnapshotEncoder({ ...world, gameTime: 1 });
    expect(decodeSnapshotMessage(decoder, snapshotMessage(next.encode(5)))).toEqual(next.state);
  }
);
