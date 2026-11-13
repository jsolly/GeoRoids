import { expect, test } from 'vitest';
import { haulerUtilityOf, scoutUtilityOf } from '../../../shared/shipUtilities';
import { SnapshotDecoder } from '../../../shared/snapshotProtocol';
import { decodeSnapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

function receivePilot(utilityFields: Record<string, unknown>) {
  const world = snapshotFixture();
  const pilot = world.entities[0];
  if (!pilot) {
    throw new Error('Utility snapshot requires a pilot');
  }
  const snapshot = decodeSnapshotMessage(
    new SnapshotDecoder('diagnostic'),
    JSON.stringify({
      type: 'snapshot',
      data: {
        version: 3,
        kind: 'keyframe',
        sequence: 1,
        state: { ...world, entities: [{ ...pilot, ...utilityFields }] },
      },
    })
  );
  const received = snapshot.entities[0];
  if (!received) {
    throw new Error('Accepted utility snapshot lost its pilot');
  }
  return received;
}

test('snapshot v3 accepts every current Hauler and Scout utility', () => {
  for (const haulerUtility of ['tow_cable', 'resource_tap', 'boost_coupling']) {
    const pilot = receivePilot({ kitId: 'hauler', haulerUtility });
    expect(pilot.haulerUtility).toBe(haulerUtility);
    expect(haulerUtilityOf(pilot)).toBe(haulerUtility);
  }
  for (const scoutUtility of ['mineral_scan', 'survey_probe']) {
    const pilot = receivePilot({ kitId: 'scout', scoutUtility });
    expect(pilot.scoutUtility).toBe(scoutUtility);
    expect(scoutUtilityOf(pilot)).toBe(scoutUtility);
  }
});

test('missing utility fields preserve the Tow Cable and Mineral Scan defaults', () => {
  const hauler = receivePilot({ kitId: 'hauler' });
  const scout = receivePilot({ kitId: 'scout' });
  expect(hauler.haulerUtility).toBeUndefined();
  expect(haulerUtilityOf(hauler)).toBe('tow_cable');
  expect(scout.scoutUtility).toBeUndefined();
  expect(scoutUtilityOf(scout)).toBe('mineral_scan');
});

test('snapshot v3 rejects unknown, cross-kit, and malformed utility tokens', () => {
  for (const scoutUtility of [
    'tow_cable',
    'build_furnace',
    'unknown',
    'constructor',
    null,
    7,
    {},
  ]) {
    expect(() => receivePilot({ kitId: 'scout', scoutUtility })).toThrow(
      'Incomplete or invalid public snapshot DTO'
    );
  }
  for (const haulerUtility of ['mineral_scan', 'build_furnace', 'constructor', null, 7, {}]) {
    expect(() => receivePilot({ kitId: 'hauler', haulerUtility })).toThrow(
      'Incomplete or invalid public snapshot DTO'
    );
  }
});
