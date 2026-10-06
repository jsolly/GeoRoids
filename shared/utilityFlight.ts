import type { Position, UtilityFlight } from '../shared-types';

export const UTILITY_FLIGHT = {
  TOW_SPEED: 8,
  PROBE_SPEED: 10,
  REEL_SPEED: 12,
  REEL_MAX_FRAMES: 120,
  DISINTEGRATE_FRAMES: 24,
} as const;

interface FlightHost {
  position: Position;
  utilityFlight?: UtilityFlight | null;
}

export function launchUtilityFlight(
  host: { position: Position; angle: number },
  kind: 'tow' | 'probe',
  nose: number,
  range: number
): UtilityFlight {
  const dx = Math.cos(host.angle);
  const dy = -Math.sin(host.angle);
  const speed = kind === 'tow' ? UTILITY_FLIGHT.TOW_SPEED : UTILITY_FLIGHT.PROBE_SPEED;
  return {
    kind,
    phase: 'outbound',
    position: { x: host.position.x + dx * nose, y: host.position.y + dy * nose },
    velocity: { x: dx * speed, y: dy * speed },
    remainingDistance: range,
  };
}

/** End flight on a miss or obstruction; returning cables never attach. */
export function missUtilityFlight(host: FlightHost): void {
  const flight = host.utilityFlight;
  if (flight?.phase !== 'outbound') {
    return;
  }
  host.utilityFlight =
    flight.kind === 'tow'
      ? {
          kind: 'tow',
          phase: 'reeling',
          position: { ...flight.position },
          framesLeft: UTILITY_FLIGHT.REEL_MAX_FRAMES,
        }
      : {
          kind: 'probe',
          phase: 'disintegrating',
          position: { ...flight.position },
          framesLeft: UTILITY_FLIGHT.DISINTEGRATE_FRAMES,
        };
}

/** Advance one simulation frame, returning only the outbound swept segment. */
export function advanceUtilityFlight(
  host: FlightHost
): { start: Position; end: Position } | undefined {
  const flight = host.utilityFlight;
  if (!flight) {
    return;
  }
  if (flight.phase === 'disintegrating') {
    if (--flight.framesLeft <= 0) {
      host.utilityFlight = null;
    }
    return;
  }
  if (flight.phase === 'reeling') {
    const dx = host.position.x - flight.position.x;
    const dy = host.position.y - flight.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= UTILITY_FLIGHT.REEL_SPEED || --flight.framesLeft <= 0) {
      host.utilityFlight = null;
      return;
    }
    flight.position.x += (dx / distance) * UTILITY_FLIGHT.REEL_SPEED;
    flight.position.y += (dy / distance) * UTILITY_FLIGHT.REEL_SPEED;
    return;
  }
  if (flight.remainingDistance <= 0) {
    missUtilityFlight(host);
    return;
  }
  const start = { ...flight.position };
  const speed = Math.hypot(flight.velocity.x, flight.velocity.y);
  const step = Math.min(speed, flight.remainingDistance);
  const ratio = speed > 0 ? step / speed : 0;
  flight.position.x += flight.velocity.x * ratio;
  flight.position.y += flight.velocity.y * ratio;
  flight.remainingDistance = Math.max(0, flight.remainingDistance - step);
  return { start, end: { ...flight.position } };
}
