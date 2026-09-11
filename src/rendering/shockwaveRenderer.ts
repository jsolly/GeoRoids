import { PALETTE, VISUAL } from '../constants';
import { shockwaveManager } from '../fx/ShockwaveManager';
import {
  easedRingRadius,
  ringAlpha,
  SHOCKWAVE_WAVES,
  type ShockwaveWaveId,
  waveVisualProgress,
} from '../physics/shockwave';
import { hexToRgba } from '../utils/colorUtils';
import { canvasManager } from './canvas';
import { resolveGlow } from './renderQuality';

const WAVE_COLOR: Record<ShockwaveWaveId, string> = {
  fast: PALETTE.LASER_LOCAL,
  heavy: PALETTE.LOCAL,
};

const WAVE_PEAK_ALPHA: Record<ShockwaveWaveId, number> = {
  fast: 0.82,
  heavy: 1,
};

export function drawShockwaves(
  viewerPosition: { x: number; y: number },
  now = performance.now()
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }

  const active = shockwaveManager.getActive(now);
  if (active.length === 0) {
    return;
  }

  for (const fx of active) {
    const ageMs = now - fx.startedAt;
    const screen = canvasManager.worldToScreen(fx.origin, viewerPosition);

    for (const wave of SHOCKWAVE_WAVES) {
      const progress = waveVisualProgress(ageMs, wave);
      if (progress === null) {
        continue;
      }

      const radius = easedRingRadius(progress, wave.radius);
      if (radius <= 0.5) {
        continue;
      }

      const color = WAVE_COLOR[wave.id];
      const alpha = ringAlpha(progress, WAVE_PEAK_ALPHA[wave.id]);
      const glow = Math.min(wave.strokeWidth, VISUAL.SHIP_GLOW);

      ctx.save();
      ctx.strokeStyle = hexToRgba(color, alpha);
      ctx.lineWidth = wave.strokeWidth;
      ctx.shadowColor = color;
      ctx.shadowBlur = resolveGlow(glow);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      if (wave.id === 'heavy') {
        ctx.strokeStyle = hexToRgba(PALETTE.LASER_LOCAL, alpha * 0.55);
        ctx.lineWidth = Math.max(1, wave.strokeWidth * 0.55);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius * 1.04, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = hexToRgba(PALETTE.HUD, alpha * 0.55);
        ctx.lineWidth = Math.max(1, wave.strokeWidth * 0.45);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius * 0.9, 0, Math.PI * 2);
        ctx.stroke();

        const ticks = 12;
        const tickInner = radius * 0.84;
        ctx.strokeStyle = hexToRgba(PALETTE.LASER_LOCAL, alpha * 0.7);
        ctx.lineWidth = 1;
        for (let i = 0; i < ticks; i++) {
          const angle = (Math.PI * 2 * i) / ticks;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(screen.x + cos * tickInner, screen.y + sin * tickInner);
          ctx.lineTo(screen.x + cos * radius, screen.y + sin * radius);
          ctx.stroke();
        }
      }

      ctx.restore();
    }
  }

  ctx.shadowBlur = 0;
}
