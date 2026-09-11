import type { Position } from '../../../shared-types';
import { canvasManager } from '../../rendering/canvas';
import type { DrawingContext } from '../../rendering/drawingContext';
import { SHIP_ABILITY } from './shipKits';

const PULSE_DURATION_MS = 650;
const PULSE_BLUE = '#60A5FA';
interface PulseShip {
  kitId: string;
}

const pulses = new WeakMap<PulseShip, { origin: Position; startedAt: number }>();

/** Capture activation before movement; an authoritative echo corrects origin without restarting. */
export function startQuakePulse(
  ship: PulseShip,
  origin: Position,
  elapsedMs = 0,
  now = performance.now()
): void {
  if (ship.kitId !== 'quake') {
    return;
  }
  const previous = pulses.get(ship);
  const startedAt =
    previous && now - previous.startedAt < PULSE_DURATION_MS
      ? Math.min(previous.startedAt, now - elapsedMs)
      : now - elapsedMs;
  pulses.set(ship, { origin: { ...origin }, startedAt });
}

/** The visual expands to the same radius used by the instantaneous gameplay impulse. */
export function paintQuakePulse(
  ctx: DrawingContext,
  origin: Position,
  maxRadius: number,
  progress: number
): void {
  if (progress < 0 || progress >= 1) {
    return;
  }
  const radius = maxRadius * (1 - (1 - progress) ** 2);
  if (radius <= 1) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = PULSE_BLUE;
  ctx.lineWidth = 2.5;
  ctx.globalAlpha = 0.95 * (1 - progress);
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.globalAlpha *= 0.55;
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, radius * 0.9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawQuakePulseRelative(
  ship: PulseShip,
  viewer: Position,
  now = performance.now()
): void {
  if (ship.kitId !== 'quake') {
    pulses.delete(ship);
    return;
  }
  const pulse = pulses.get(ship);
  if (!pulse) {
    return;
  }
  const progress = (now - pulse.startedAt) / PULSE_DURATION_MS;
  const ctx = canvasManager.getContext();
  if (ctx && progress < 1) {
    paintQuakePulse(
      ctx,
      canvasManager.worldToScreen(pulse.origin, viewer),
      SHIP_ABILITY.SHOCK_RADIUS * canvasManager.getPlayfieldScale(),
      progress
    );
  }
}
