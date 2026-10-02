// @vitest-environment node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { canonicalJson } from '../../../benchmarks/results';
import { readRelativeMotion } from '../../../shared/snapshotMotion';
import { quantizeSnapshotKinematics } from '../../../shared/snapshotPrecision';
import {
  type SnapshotBaseline,
  SnapshotDecoder,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../../shared-types';
import { snapshotFixture } from './snapshotFixture';

/** Native JSON supplies an independent unknown-field, omission and sparse-array oracle. */
function hash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(value))))
    .digest('hex');
}

test('a pilot reconstructs more than a thousand consecutive deltas and a full recovery after a rejected baseline', () => {
  const world = snapshotFixture();
  world.entities = world.entities.slice(0, 2);
  world.asteroids = world.asteroids.slice(0, 24);
  for (const asteroid of world.asteroids) {
    asteroid.velocity = { x: 0.25, y: -0.5 };
    asteroid.angularVelocity = 0.125;
  }
  const nearLimit = world.asteroids.find((asteroid) => asteroid.id === 'asteroid-1');
  assert(nearLimit);
  nearLimit.position.x = 900_000_000_000.125;
  const decoder = new SnapshotDecoder();
  let baseline: SnapshotBaseline | undefined;
  let elapsedTicks = 0;
  let predictedRecords = 0;
  const observePrediction = (_ordinal: number, mask: number): number[] => {
    predictedRecords++;
    return Array((mask & 1 ? 2 : 0) + (mask & 2 ? 1 : 0) + (mask & 4 ? 2 : 0)).fill(0);
  };
  let deltaRun = 0;
  let longestDeltaRun = 0;
  let appliedStates = 0;
  let rejectedStates = 0;
  let fullStates = 0;
  const rejectionSequence = 1041;
  const recoverySequence = rejectionSequence + 1;
  const states = 1107;

  for (let sequence = 1; sequence <= states; sequence++) {
    const ticks = sequence === 1 ? 0 : sequence % 11 === 0 ? 7 : sequence % 5 === 0 ? 3 : 2;
    elapsedTicks += ticks;
    world.gameTime = elapsedTicks;
    world.serverTime = 1_700_000_000_000 + elapsedTicks * (1000 / 60);
    if (sequence % 17 === 0) {
      delete world.serverTime;
    }
    for (const asteroid of world.asteroids) {
      asteroid.position.x += asteroid.velocity.x * ticks;
      asteroid.position.y += asteroid.velocity.y * ticks;
      asteroid.rotation = (asteroid.rotation + asteroid.angularVelocity * ticks) % (2 * Math.PI);
    }
    const anchor = world.asteroids.find((asteroid) => asteroid.id === 'asteroid-0');
    assert(anchor);
    if (sequence % 83 === 0) {
      anchor.velocity.x *= -1;
      anchor.angularVelocity *= -1;
      anchor.position.x += 17.125;
    }
    if (sequence % 7 === 0) {
      Reflect.deleteProperty(world, 'futureWorld');
      Reflect.deleteProperty(anchor.position, 'futurePosition');
    } else {
      const sparse: unknown[] = Array(3);
      sparse[1] = null;
      Object.assign(world, {
        futureWorld: {
          label: '飛行士 🛰️ Δ',
          values: [sequence, false, null, { optional: sequence % 2 ? true : undefined }],
          sparse,
        },
      });
      Object.assign(anchor.position, {
        futurePosition: { precise: 0.123456789, revision: sequence },
      });
    }
    if (sequence % 37 === 0) {
      const retiring = world.asteroids.findIndex(
        (asteroid) => asteroid.id !== 'asteroid-0' && asteroid.id !== 'asteroid-1'
      );
      assert(retiring >= 0);
      world.asteroids.splice(retiring, 1);
      world.asteroids.push({ ...structuredClone(anchor), id: `long-chain-added-${sequence}` });
    }
    if (sequence % 53 === 0) {
      world.asteroids.reverse();
    }

    // This oracle uses native JSON and the precision rule, without applying any wire patch.
    const expected = JSON.parse(JSON.stringify(world)) as ServerGameSnapshot;
    quantizeSnapshotKinematics(expected);
    const expectedHash = hash(expected);
    const sourceHash = hash(world);
    const encoder = new SnapshotEncoder(world);
    const ordinary = encoder.encodeSerialized(sequence, baseline, 1000 + sequence);
    expect(hash(world), `source mutation at sequence ${sequence}`).toBe(sourceHash);
    if (sequence > 1) {
      expect(ordinary.frame.kind, `unexpected full frame at sequence ${sequence}`).toBe('delta');
    }
    if (ordinary.frame.kind === 'delta') {
      expect(ordinary.frame.baseline).toBe(sequence - 1);
      const motion = ordinary.frame.patch.collections?.['asteroids']?.motion;
      if (motion !== undefined) {
        assert(baseline);
        // Count explicit prediction-bit records; the real decoder independently
        // reconstructs their actual values against the true retained baseline.
        readRelativeMotion(
          motion,
          baseline.state.asteroids.length,
          true,
          () => {},
          observePrediction
        );
      }
    }
    if (sequence === rejectionSequence) {
      assert(ordinary.frame.kind === 'delta');
      const corrupted = JSON.stringify({
        type: 'snapshot',
        data: { ...ordinary.frame, baseline: sequence - 2 },
      });
      const rejected = decoder.readMessage(corrupted, { acceptSnapshots: true });
      assert(rejected.kind === 'snapshot-rejected');
      expect(rejected.error.message).toContain('baseline');
      rejectedStates++;
      // Transport advanced the sender's baseline, but the pilot rejected this world.
      baseline = { sequence, state: encoder.state };
      continue;
    }
    let text = ordinary.text;
    if (sequence === recoverySequence) {
      const stillMissing = decoder.readMessage(text, { acceptSnapshots: true });
      assert(stillMissing.kind === 'snapshot-rejected');
      expect(stillMissing.error.message).toContain('baseline');
      rejectedStates++;
      const recovery = encoder.encodeSerialized(sequence, undefined, 1000 + sequence);
      expect(recovery.frame.kind).toBe('keyframe');
      text = recovery.text;
    }
    const result = decoder.readMessage(text, { acceptSnapshots: true });
    assert(result.kind === 'snapshot', `sequence ${sequence} failed complete application`);
    expect(result.metadata.sequence).toBe(sequence);
    expect(hash(result.state), `decoded world mismatch at sequence ${sequence}`).toBe(expectedHash);
    appliedStates++;
    if (result.metadata.kind === 'delta') {
      deltaRun++;
      longestDeltaRun = Math.max(longestDeltaRun, deltaRun);
    } else {
      fullStates++;
      deltaRun = 0;
    }
    // Mutating an applied world must not poison the decoder's private baseline.
    if (sequence % 19 === 0) {
      const appliedRock = result.state.asteroids[0];
      assert(appliedRock);
      appliedRock.position.x = -123_456;
    }
    baseline = { sequence, state: encoder.state };
  }
  expect(longestDeltaRun).toBeGreaterThan(1000);
  expect(predictedRecords).toBeGreaterThan(1000);
  expect(appliedStates).toBe(states - 1);
  expect(rejectedStates).toBe(2);
  expect(fullStates).toBe(2);
});
