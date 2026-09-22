import { afterEach, expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import {
  getWorldMapAssets,
  resetWorldExploration,
  setWorldMapAssets,
} from '../../../src/network/worldExploration';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

afterEach(() => {
  resetWorldExploration();
});

test('a street-era server still joins and its lots stay off the map', () => {
  const state = snapshotFixture();
  state.mapAssets = [
    {
      id: 'foundation:lot-1',
      kind: 'foundation',
      position: { x: 12, y: 34 },
      name: 'Civic lot',
    },
    {
      id: 'furnace:town-square',
      kind: 'furnace',
      position: { x: 0, y: 0 },
      name: 'Town Square',
    },
  ];
  const wire = JSON.parse(
    snapshotMessage({ version: 1, sequence: 1, kind: 'keyframe', state })
  ) as {
    data: { state: { entities: Array<{ surveyorUtility?: string }> } };
  };
  const pilot = wire.data.state.entities[0];
  if (!pilot) {
    throw new Error('Snapshot fixture has no pilot');
  }
  pilot.surveyorUtility = 'build_furnace';

  const decoder = new SnapshotDecoder();
  const joined = decodeSnapshotMessage(decoder, JSON.stringify(wire));
  expect(joined.mapAssets.map((asset) => asset.kind)).toEqual(['foundation', 'furnace']);
  expect(joined.entities[0]?.surveyorUtility).toBe('build_furnace');

  const followed = decodeSnapshotMessage(
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
            mapAssets: {
              add: [
                {
                  id: 'loot:core',
                  kind: 'laserCore',
                  position: { x: 1, y: 2 },
                  name: 'Laser core',
                },
              ],
              update: [],
              remove: [],
              order: ['foundation:lot-1', 'furnace:town-square', 'loot:core'],
            },
            entities: {
              add: [],
              update: [['pilot-0', { surveyorUtility: 'build_furnace' }, []]],
              remove: [],
            },
          },
        },
      },
    })
  );
  expect(followed.mapAssets.map((asset) => asset.id)).toEqual([
    'foundation:lot-1',
    'furnace:town-square',
    'loot:core',
  ]);
  expect(followed.entities[0]?.surveyorUtility).toBe('build_furnace');

  const cleared = decodeSnapshotMessage(
    decoder,
    JSON.stringify({
      type: 'snapshot',
      data: {
        version: 1,
        sequence: 3,
        kind: 'delta',
        baseline: 2,
        patch: {
          set: {},
          clear: [],
          collections: {
            entities: {
              add: [],
              update: [['pilot-0', {}, ['surveyorUtility']]],
              remove: [],
            },
          },
        },
      },
    })
  );
  expect(cleared.entities[0]?.surveyorUtility).toBeUndefined();
  expect(cleared.mapAssets.some((asset) => asset.id === 'foundation:lot-1')).toBe(true);

  const probed = decodeSnapshotMessage(
    decoder,
    JSON.stringify({
      type: 'snapshot',
      data: {
        version: 1,
        sequence: 4,
        kind: 'delta',
        baseline: 3,
        patch: {
          set: {},
          clear: [],
          collections: {
            entities: {
              add: [],
              update: [['pilot-0', { surveyorUtility: 'survey_probe' }, []]],
              remove: [],
            },
          },
        },
      },
    })
  );
  expect(probed.entities[0]?.surveyorUtility).toBe('survey_probe');
  expect(probed.mapAssets.some((asset) => asset.kind === 'foundation')).toBe(true);

  setWorldMapAssets(probed.mapAssets);
  expect(getWorldMapAssets().map((asset) => asset.kind)).toEqual(['furnace', 'laserCore']);
});
