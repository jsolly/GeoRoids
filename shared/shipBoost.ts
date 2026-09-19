import type { ShipBoostState } from '../shared-types';

export const BOOST = { durationMs: 3000, rechargeMs: 5000 } as const;

export function fullShipBoost(): ShipBoostState {
  return { phase: 'idle', charge: 1 };
}

export function stopShipBoost(boost: ShipBoostState): void {
  if (boost.phase === 'active') {
    boost.phase = 'idle';
  }
}

/** Any available charge can start a new burst, interrupting recharge. */
export function startShipBoost(boost: ShipBoostState): boolean {
  if (boost.charge <= 0) {
    return false;
  }
  boost.phase = 'active';
  return true;
}

/** Shared by fixed-step prediction and the server's elapsed-time budget. */
export function advanceShipBoost(boost: ShipBoostState, elapsedMs: number): void {
  let remainingMs = elapsedMs;
  if (boost.phase === 'active') {
    const untilEmpty = boost.charge * BOOST.durationMs;
    if (remainingMs < untilEmpty - 1e-7) {
      boost.charge -= remainingMs / BOOST.durationMs;
      return;
    }
    remainingMs = Math.max(0, remainingMs - untilEmpty);
    boost.phase = 'exhausted';
    boost.charge = 0;
  }
  boost.charge = Math.min(1, boost.charge + remainingMs / BOOST.rechargeMs);
  if (boost.charge >= 1 - 1e-9) {
    boost.charge = 1;
    boost.phase = 'idle';
  }
}

export function isShipBoostState(value: unknown): value is ShipBoostState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'phase' in value &&
    (value.phase === 'idle' || value.phase === 'active' || value.phase === 'exhausted') &&
    'charge' in value &&
    typeof value.charge === 'number' &&
    Number.isFinite(value.charge) &&
    value.charge >= 0 &&
    value.charge <= 1 &&
    (value.phase !== 'active' || value.charge > 0) &&
    (value.phase !== 'exhausted' || value.charge < 1)
  );
}
