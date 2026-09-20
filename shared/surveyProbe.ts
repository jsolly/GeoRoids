import type { AsteroidProbe, Position } from '../shared-types';

/** Authoritative Surveyor probe tuning shared by the server and renderer. */
export const SURVEY_PROBE = {
  /** Radius of the scan around the beacon. */
  RANGE: 600,
  /** Maximum forward distance used by a launch hitscan. */
  LAUNCH_RANGE: 700,
  /** Time between authoritative scan pulses. */
  PULSE_MS: 3_000,
  /** Time a beacon remains attached to its host asteroid. */
  LIFETIME_MS: 300_000,
  /** Maximum active beacons credited to one Surveyor. */
  MAX_PER_OWNER: 3,
  /** Collision and rendered radius of the beacon. */
  RADIUS: 10,
  /** Beacon hull health. */
  MAX_HEALTH: 40,
  /** Client warning threshold before expiry. */
  WARNING_MS: 30_000,
  /** Frames before the same Surveyor may launch another beacon. */
  COOLDOWN_FRAMES: 180,
} as const;

interface SurveyProbeHost {
  position: Position;
  rotation: number;
}

/**
 * Resolve the beacon's world position from its host pose.
 *
 * `angle` is deliberately local to the asteroid. A beacon therefore follows
 * both translation and rotation without storing a second world position.
 */
export function probePosition(
  host: SurveyProbeHost,
  probe: Pick<AsteroidProbe, 'angle' | 'radialOffset'>
): Position {
  const angle = host.rotation + probe.angle;
  return {
    x: host.position.x + Math.cos(angle) * probe.radialOffset,
    y: host.position.y + Math.sin(angle) * probe.radialOffset,
  };
}
