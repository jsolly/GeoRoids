import { probePosition, SURVEY_PROBE } from '../../../shared/surveyProbe';
import type { AsteroidProbe, Position } from '../../../shared-types';
import { PALETTE } from '../../constants';
import { canvasManager } from '../../rendering/canvasSurface';
import type { DrawingContext } from '../../rendering/drawingContext';
import { drawSatelliteHealth } from '../satellitePickup/satelliteHealthRenderer';
import type { Roid } from './Roid';

/** The ring reaches the same world radius the beacon surveys on each pulse. */
export function drawSurveyProbe(
  ctx: DrawingContext,
  probe: AsteroidProbe,
  center: Position,
  scale: number,
  now: number
): void {
  if (probe.health <= 0) {
    return;
  }
  const age = Math.max(0, now - probe.attachedAt);
  const phase = (age % SURVEY_PROBE.PULSE_MS) / SURVEY_PROBE.PULSE_MS;
  const warning = probe.expiresAt - now <= SURVEY_PROBE.WARNING_MS;
  const color = warning ? PALETTE.LASER_LOCAL : PALETTE.LOCAL;
  const radius = SURVEY_PROBE.RADIUS * scale;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = (1 - phase) * 0.25;
  ctx.beginPath();
  ctx.arc(center.x, center.y, SURVEY_PROBE.RANGE * phase * scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = warning ? 0.55 + 0.45 * Math.sin(age / 130) ** 2 : 1;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y - radius);
  ctx.lineTo(center.x + radius, center.y);
  ctx.lineTo(center.x, center.y + radius);
  ctx.lineTo(center.x - radius, center.y);
  ctx.closePath();
  ctx.fillStyle = PALETTE.BG;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(center.x, center.y, Math.max(1.5, radius * 0.25), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  drawSatelliteHealth(ctx, { ...probe, state: 'orbiting' }, center, radius, true);
  ctx.restore();
}

export function drawSurveyProbes(roids: readonly Roid[], camera: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const scale = canvasManager.getPlayfieldScale();
  const now = Date.now();
  for (const roid of roids) {
    if (!roid.probe || roid.health <= 0) {
      continue;
    }
    const position = probePosition({ position: roid.position, rotation: roid.angle }, roid.probe);
    const screen = canvasManager.worldToScreen(position, camera);
    drawSurveyProbe(ctx, roid.probe, screen, scale, now);
  }
}
