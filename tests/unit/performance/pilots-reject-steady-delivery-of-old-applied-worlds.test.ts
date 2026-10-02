import { expect, test } from 'vitest';
import { appliedFreshness, type FreshnessObservation } from '../../../benchmarks/applied-freshness';

function pilot(sequence: number, gameTime: number, serverTime: number): FreshnessObservation {
  return {
    id: 'browser',
    session: 1,
    pendingRecovery: false,
    applied: { sequence, kind: 'delta', gameTime, serverTime },
  };
}

test('steady arrivals preserve growing server lag when the applied world falls behind', () => {
  const first = pilot(10, 60, 1000);
  const second = pilot(11, 90, 1500);
  expect(
    appliedFreshness({ gameTime: 120, serverTime: 2000 }, first, undefined, 'steady')
  ).toMatchObject({
    kind: 'valid',
    serverToAppliedMs: 1000,
    simulationLagTicks: 60,
  });
  expect(
    appliedFreshness({ gameTime: 180, serverTime: 3000 }, second, first, 'steady')
  ).toMatchObject({
    kind: 'valid',
    serverToAppliedMs: 1500,
    simulationLagTicks: 90,
  });
  // Another observation of the same applied snapshot still increases its age.
  expect(
    appliedFreshness({ gameTime: 240, serverTime: 4000 }, second, second, 'steady')
  ).toMatchObject({
    kind: 'valid',
    serverToAppliedMs: 2500,
    simulationLagTicks: 150,
  });
});

test('missing, ahead and regressed applied worlds cannot establish freshness', () => {
  const previous = pilot(10, 60, 1000);
  const clock = { gameTime: 120, serverTime: 2000 };
  for (const observation of [
    { ...previous, applied: undefined },
    { ...previous, pendingRecovery: true },
    { ...previous, session: Number.NaN },
    {
      ...previous,
      applied: { sequence: 11, kind: 'delta' as const, gameTime: 90, serverTime: undefined },
    },
    pilot(11, 121, 1500),
    pilot(11, 90, 2001),
    pilot(9, 90, 1500),
    pilot(11, 59, 1500),
    pilot(11, 90, 999),
    pilot(10, 90, 1500),
  ]) {
    expect(appliedFreshness(clock, observation, previous, 'steady')).toMatchObject({
      kind: 'invalid',
      observation,
    });
  }
});

test('a rejoined pilot must enter explicit recovery before its sequence can restart', () => {
  const previous = pilot(10, 60, 1000);
  const rejoined = { ...pilot(1, 90, 1500), session: 2 };
  const clock = { gameTime: 120, serverTime: 2000 };
  expect(appliedFreshness(clock, rejoined, previous, 'steady')).toMatchObject({ kind: 'invalid' });
  expect(appliedFreshness(clock, rejoined, previous, 'recovery')).toMatchObject({
    kind: 'valid',
    serverToAppliedMs: 500,
    simulationLagTicks: 30,
  });
  expect(
    appliedFreshness(clock, { ...rejoined, applied: undefined }, previous, 'recovery')
  ).toMatchObject({ kind: 'invalid' });
  for (const observation of [
    { ...rejoined, session: 0 },
    { ...pilot(1, 59, 1500), session: 2 },
    { ...pilot(1, 90, 999), session: 2 },
  ]) {
    expect(appliedFreshness(clock, observation, previous, 'recovery')).toMatchObject({
      kind: 'invalid',
      observation,
    });
  }
});
