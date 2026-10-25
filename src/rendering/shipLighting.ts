import { GLOWTOY } from '../../shared/glowtoy';
import type { MapAsset, Position } from '../../shared-types';
import { contourSpeedStrength } from '../entities/ship/cruiseMotion';
import type { Ship } from '../entities/ship/Ship';
import { getWorldRemains } from '../network/worldExploration';
import { canvasManager } from './canvasSurface';
import type { DrawingContext } from './drawingContext';

/** Opaque wreck silhouettes clip only the cone, leaving the rest of the scene untouched. */
export function drawHeadlight(
  ctx: DrawingContext & Pick<CanvasRenderingContext2D, 'clip' | 'createLinearGradient'>,
  at: Position,
  angle: number,
  scale: number,
  ghosts: readonly Position[]
): void {
  const range = GLOWTOY.headlightRange * scale;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(-angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(range, -range * Math.tan(0.42));
  ctx.lineTo(range, range * Math.tan(0.42));
  ctx.closePath();
  ctx.clip();
  const light = ctx.createLinearGradient(0, 0, range, 0);
  light.addColorStop(0, 'rgba(165,214,234,0.10)');
  light.addColorStop(1, 'rgba(165,214,234,0)');
  ctx.fillStyle = light;
  ctx.fillRect(0, -range, range, range * 2);
  for (const ghost of ghosts) {
    const dx = ghost.x - at.x;
    const dy = ghost.y - at.y;
    const x = dx * Math.cos(angle) - dy * Math.sin(angle);
    const y = dx * Math.sin(angle) + dy * Math.cos(angle);
    const radius = 20 * scale;
    if (x < radius || x > range || Math.abs(y) > x * 0.5 + radius) {
      continue;
    }
    const far = range / x;
    ctx.fillStyle = 'rgba(3,7,13,0.65)';
    ctx.beginPath();
    ctx.moveTo(x, y - radius);
    ctx.lineTo(range, (y - radius) * far);
    ctx.lineTo(range, (y + radius) * far);
    ctx.lineTo(x, y + radius);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawEngineLight(
  ctx: DrawingContext,
  at: Position,
  angle: number,
  radius: number,
  boosting: boolean,
  now = performance.now(),
  /** Supplied once per frame by `drawShipLighting`; read here only for direct callers. */
  reducedMotion?: boolean
): void {
  const reduced =
    reducedMotion ??
    (typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const flicker = reduced ? 1 : 0.95 + Math.sin(now / 47) * 0.05;
  const length = radius * (boosting ? 6 : 4) * flicker;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(-angle);
  const light = ctx.createRadialGradient(-radius, 0, 0, -radius * 2, 0, length);
  light.addColorStop(0, boosting ? 'rgba(179,123,255,0.24)' : 'rgba(95,204,245,0.16)');
  light.addColorStop(1, 'rgba(95,204,245,0)');
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.ellipse(-radius * 2, 0, length, length * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawShipLighting(viewer: Position, ships: readonly Ship[]): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const scale = canvasManager.getPlayfieldScale();
  const viewport = canvasManager.getViewportSize();
  const ghosts = getWorldRemains()
    .filter((asset: MapAsset) => asset.kind === 'ship-remains')
    .map((asset) => canvasManager.worldToScreen(asset.position, viewer));
  // One preference read per frame, shared by every thrusting ship. Querying it per
  // ship parses the media query and allocates a MediaQueryList each time.
  let reducedMotion: boolean | undefined;
  for (const ship of ships) {
    if (ship.exploding || ship.health <= 0 || ship.furnaceTransit) {
      continue;
    }
    const at = canvasManager.worldToScreen(ship.position, viewer);
    const padding = GLOWTOY.headlightRange * scale;
    if (
      at.x < -padding ||
      at.y < -padding ||
      at.x > viewport.width + padding ||
      at.y > viewport.height + padding
    ) {
      continue;
    }
    const angle = ship.angle;
    drawHeadlight(ctx, at, angle, scale, ghosts);
    if (ship.thrusting) {
      reducedMotion ??=
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      drawEngineLight(
        ctx,
        at,
        angle,
        ship.r * scale,
        contourSpeedStrength(ship) > 0.25,
        performance.now(),
        reducedMotion
      );
    }
  }
}
