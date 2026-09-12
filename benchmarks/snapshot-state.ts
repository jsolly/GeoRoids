import assert from 'node:assert/strict';
import { quantizeSnapshotKinematics } from '../shared/snapshotPrecision';
import type { ServerGameSnapshot } from '../shared-types';

export const SELECTED_SNAPSHOT_CONTRACT =
  'quantizeSnapshotKinematics(structuredClone(originalWorld))';

/** Check the complete wire world against an independently rounded source copy. */
export function assertSelectedSnapshotState(
  decoded: ServerGameSnapshot,
  original: ServerGameSnapshot
): void {
  const expected = structuredClone(original);
  quantizeSnapshotKinematics(expected);
  assert.deepEqual(decoded, expected, 'Decoded snapshot changed the selected-precision state');
}
