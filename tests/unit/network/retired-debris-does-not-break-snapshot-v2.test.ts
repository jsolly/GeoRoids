import { expect, test } from 'vitest';
import { validateSnapshotDto } from '../../../shared/snapshotDto';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { LootData } from '../../../shared-types';
import { LootField } from '../../../src/entities/loot/LootField';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

test('a client accepts snapshot v2 cargo markers and ignores retired debris from an older server', () => {
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
  world.loot = [{ ...cargo, id: 'old-debris', kind: 'wreckage' }, cargo];
  expect(() => validateSnapshotDto(world)).not.toThrow();
  field.applySnapshot(world.loot);
  expect(field.getAll()).toEqual([cargo]);
});

test('a new client applies reserved consumption-history deltas from an older v2 server', () => {
  const world = snapshotFixture();
  world.spiderField = Object.assign(world.spiderField ?? { spiders: [], nests: [] }, {
    consumed: [{ id: 'old-spider', position: { x: 2, y: 3 }, furnaceId: 'hearth', frame: 4 }],
  });
  const decoder = new SnapshotDecoder();
  decodeSnapshotMessage(decoder, snapshotMessage(new SnapshotEncoder(world).encode(1)));
  const updated = { id: 'old-spider', position: { x: 2, y: 3 }, furnaceId: 'hearth', frame: 5 };
  const result = decodeSnapshotMessage(
    decoder,
    snapshotMessage({
      version: 2,
      sequence: 2,
      kind: 'delta',
      baseline: 1,
      patch: {
        objects: { spiderField: { collections: { consumed: { update: [[0, updated]] } } } },
      },
    })
  );
  expect(result.spiderField).toEqual(expect.objectContaining({ consumed: [updated] }));
});
