import { STEERING } from '../constants';
import { PLAYFIELD_CLOSE_SCALE } from '../rendering/playfieldCamera';

/** CSS-pixel offsets keep pointer steering stable across canvas backing resolutions. */
export function pointerHeadingFromCenter(
  dx: number,
  dy: number,
  hullRadius: number
): number | null {
  return Math.hypot(dx, dy) <= Math.max(STEERING.DEAD_ZONE_PX, hullRadius * PLAYFIELD_CLOSE_SCALE)
    ? null
    : Math.atan2(-dy, dx);
}

export function steeringTurn(current: number, desired: number, maxTurn: number): number {
  const delta = desired - current;
  const shortest = Math.atan2(Math.sin(delta), Math.cos(delta));
  return Math.max(-maxTurn, Math.min(maxTurn, shortest));
}
