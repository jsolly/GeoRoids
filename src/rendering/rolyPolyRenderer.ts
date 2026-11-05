import { ROLY_POLY } from '../../shared/rolyPoly';
import type { Position, RolyPolyState } from '../../shared-types';
import { getRolyPolys } from '../physics/terrain/rolyPolySession';
import { canvasManager } from './canvasSurface';
import type { DrawingContext } from './drawingContext';

export function drawRolyPoly(
  ctx: DrawingContext,
  animal: RolyPolyState,
  position: Position,
  radius: number,
  now = performance.now(),
  /** Supplied once per frame by `drawRolyPolys`; read here only for direct callers. */
  reducedMotion?: boolean
): void {
  const reduced =
    reducedMotion ??
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const animationTime = reduced ? 0 : now;
  ctx.save();
  ctx.translate(position.x, position.y);
  ctx.rotate(
    animal.phase === 'rolling'
      ? animationTime / 100
      : Math.atan2(animal.velocity.y, animal.velocity.x)
  );
  ctx.strokeStyle = '#a6c5a8';
  ctx.fillStyle = '#233d36';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, radius, radius * (animal.phase === 'walking' ? 0.65 : 1), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (animal.phase === 'walking') {
    for (let rib = -2; rib <= 2; rib++) {
      ctx.beginPath();
      ctx.moveTo((rib * radius) / 3, -radius * 0.55);
      ctx.lineTo((rib * radius) / 3, radius * 0.55);
      ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo((rib * radius) / 3, side * radius * 0.55);
        ctx.lineTo(
          (rib * radius) / 3 + Math.sin(animationTime / 130 + rib) * radius * 0.18,
          side * radius * 0.95
        );
        ctx.stroke();
      }
    }
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.6, 0, Math.PI * 1.6);
    ctx.arc(0, 0, radius * 0.3, Math.PI * 1.6, Math.PI * 3);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawRolyPolys(viewer: Position): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const viewport = canvasManager.getViewportSize();
  const radius = ROLY_POLY.radius * canvasManager.getPlayfieldScale();
  let reducedMotion: boolean | undefined;
  for (const animal of getRolyPolys()) {
    const at = canvasManager.worldToScreen(animal.position, viewer);
    if (
      at.x < -radius ||
      at.y < -radius ||
      at.x > viewport.width + radius ||
      at.y > viewport.height + radius
    ) {
      continue;
    }
    // One CSSOM media query per frame instead of one per animal. `=== true`
    // makes the memo latch even where `matchMedia` is absent, so a missing
    // implementation is not re-probed per animal either. `performance.now()`
    // stays per-animal because the default parameter already called it there.
    reducedMotion ??=
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    drawRolyPoly(ctx, animal, at, radius, performance.now(), reducedMotion);
  }
}
