import type { ClientPerformanceMetrics } from '../src/diagnostics/performanceMetrics';
import type { readSimulationClock } from './fixture-control';

type AppliedWitness = ReturnType<ClientPerformanceMetrics['read']>['lastSnapshot'];
type SimulationClock = Awaited<ReturnType<typeof readSimulationClock>>;
export type FreshnessObservation = {
  id: string;
  session: number;
  pendingRecovery: boolean;
  applied: AppliedWitness;
};
export type AppliedFreshness =
  | {
      kind: 'valid';
      observation: FreshnessObservation;
      serverToAppliedMs: number;
      simulationLagTicks: number;
    }
  | { kind: 'invalid'; observation: FreshnessObservation; reason: string };

/** Compare clocks owned by the server; no client epoch-clock synchronization. */
export function appliedFreshness(
  clock: SimulationClock,
  observation: FreshnessObservation,
  previous: FreshnessObservation | undefined,
  phase: 'steady' | 'recovery'
): AppliedFreshness {
  const invalid = (reason: string): AppliedFreshness => ({ kind: 'invalid', observation, reason });
  const applied = observation.applied;
  if (
    !Number.isSafeInteger(observation.session) ||
    observation.session < 0 ||
    observation.pendingRecovery
  ) {
    return invalid('Missing live applied session or recovery still pending');
  }
  if (
    !applied ||
    !Number.isSafeInteger(applied.sequence) ||
    applied.sequence <= 0 ||
    !Number.isSafeInteger(applied.gameTime) ||
    applied.gameTime < 0 ||
    typeof applied.serverTime !== 'number' ||
    !Number.isFinite(applied.serverTime) ||
    applied.serverTime < 0
  ) {
    return invalid('Missing or invalid applied snapshot witness');
  }
  if (
    !Number.isSafeInteger(clock.gameTime) ||
    clock.gameTime < applied.gameTime ||
    !Number.isFinite(clock.serverTime) ||
    clock.serverTime < applied.serverTime
  ) {
    return invalid('Applied snapshot is ahead of the independent server clock');
  }
  if (previous) {
    if (observation.session < previous.session) {
      return invalid('Applied session regressed');
    }
    const prior = previous.applied;
    if (
      prior &&
      (applied.gameTime < prior.gameTime ||
        prior.serverTime === undefined ||
        applied.serverTime < prior.serverTime)
    ) {
      return invalid('Applied world clock regressed across observations');
    }
    if (observation.session !== previous.session) {
      if (phase !== 'recovery') {
        return invalid('Applied session changed outside an explicit recovery phase');
      }
    } else if (prior) {
      if (
        applied.sequence < prior.sequence ||
        (applied.sequence === prior.sequence &&
          (applied.gameTime !== prior.gameTime || applied.serverTime !== prior.serverTime))
      ) {
        return invalid('Applied snapshot witness regressed or changed without a new sequence');
      }
    }
  }
  return {
    kind: 'valid',
    observation,
    serverToAppliedMs: clock.serverTime - applied.serverTime,
    simulationLagTicks: clock.gameTime - applied.gameTime,
  };
}
