import { expect, test } from 'vitest';
import { inspectReleaseEvidence } from '../../../benchmarks/release-evidence';

const interval = {
  clientReleaseId: 'client-a',
  serverReleaseId: 'server-a',
  durationMs: 1000,
  phase: 'play',
  phaseDurationsMs: { play: 1000, respawn: 0 },
};
const transition = {
  ...interval,
  serverReleaseId: 'unknown',
  phase: 'respawn',
  phaseDurationsMs: { play: 700, respawn: 300 },
};
const health = [{ measured: true, data: { releaseId: 'server-a' } }];
test('respawn identity is independently witnessed without erasing the unknown interval', () => {
  expect(inspectReleaseEvidence([interval, transition, interval], health)).toEqual({
    clientRelease: 'client-a',
    serverRelease: 'server-a',
    transientUnknown: [{ index: 1, durationMs: 1000 }],
  });
});
test('release changes and unwitnessed unknown intervals are rejected', () => {
  for (const intervals of [
    [transition, interval],
    [interval, transition],
    [interval, { ...transition, phase: 'play' }, interval],
    [interval, transition, { ...interval, serverReleaseId: 'server-b' }],
    [interval, { ...interval, clientReleaseId: 'client-b' }],
  ]) {
    expect(() => inspectReleaseEvidence(intervals, health)).toThrow();
  }
  for (const samples of [undefined, [], [{ measured: true, data: { releaseId: 'server-b' } }]]) {
    expect(() => inspectReleaseEvidence([interval, transition, interval], samples)).toThrow();
  }
});

test('independent server health cannot change even when every client interval agrees', () => {
  expect(() =>
    inspectReleaseEvidence(
      [interval, interval],
      [...health, { measured: true, data: { releaseId: 'server-b' } }]
    )
  ).toThrow(/identity changed/);
  expect(() => inspectReleaseEvidence([interval, interval], [])).toThrow(/identity witness/);
});
