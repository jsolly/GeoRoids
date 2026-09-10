import { isAsteroidMaterial, MATERIAL_OUTLINES } from '../../../shared/asteroidMaterials';
import type { AsteroidMaterial } from '../../../shared-types';
import { PALETTE } from '../../constants';

type Point = readonly [number, number];
const DETAILS: Record<AsteroidMaterial, readonly (readonly Point[])[]> = {
  ice: [
    [
      [-0.72, 0.05],
      [-0.12, -0.22],
      [0.35, -0.7],
    ],
    [
      [-0.12, -0.22],
      [0.5, 0.43],
    ],
  ],
  metal: [
    [
      [-0.46, -0.37],
      [0.35, -0.42],
      [0.53, 0.24],
      [-0.27, 0.5],
      [-0.46, -0.37],
    ],
  ],
  rubble: [
    [
      [-0.62, -0.13],
      [-0.31, -0.49],
      [-0.04, -0.18],
      [-0.62, -0.13],
    ],
    [
      [0.12, 0.01],
      [0.48, -0.2],
      [0.53, 0.28],
    ],
    [
      [-0.32, 0.38],
      [-0.09, 0.2],
      [0.15, 0.58],
    ],
  ],
};

export function drawAsteroidMaterialDetails(
  ctx: CanvasRenderingContext2D,
  material: AsteroidMaterial,
  x: number,
  y: number,
  radius: number,
  rotation: number,
  healthFraction: number
): void {
  if (!(radius > 0) || !Number.isFinite(radius)) {
    return;
  }
  if (!isAsteroidMaterial(material)) {
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(radius, radius);
  ctx.strokeStyle = PALETTE.ROID;
  ctx.lineWidth = 0.85 / radius;
  ctx.globalAlpha = 0.62;
  ctx.shadowBlur = 0;
  for (const line of DETAILS[material]) {
    ctx.beginPath();
    for (let i = 0; i < line.length; i++) {
      const point = line[i];
      if (!point) {
        continue;
      }
      if (i === 0) {
        ctx.moveTo(point[0], point[1]);
      } else {
        ctx.lineTo(point[0], point[1]);
      }
    }
    ctx.stroke();
  }
  if (material === 'metal' && healthFraction < 1) {
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(-0.22, -0.92);
    ctx.lineTo(-0.08, -0.51);
    ctx.lineTo(0.1, -0.26);
    if (healthFraction < 0.5) {
      ctx.lineTo(-0.08, 0.12);
      ctx.lineTo(0.2, 0.63);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Contact-sheet assets use the same mineral contour and facet data as Canvas. */
export function serializeAsteroidMaterialSvg(material: AsteroidMaterial): string {
  if (!isAsteroidMaterial(material)) {
    throw new TypeError(`Unknown asteroid material: ${String(material)}`);
  }
  const offsets = MATERIAL_OUTLINES[material];
  const points = offsets
    .map((r, i) => {
      const a = (i * Math.PI * 2) / offsets.length;
      return `${(Math.cos(a) * r * 28).toFixed(3)},${(Math.sin(a) * r * 28).toFixed(3)}`;
    })
    .join(' ');
  const details = DETAILS[material]
    .map(
      (line) =>
        `<polyline opacity="0.62" points="${line.map(([x, y]) => `${x * 28},${y * 28}`).join(' ')}"/>`
    )
    .join('');
  const title = `${material.charAt(0).toUpperCase()}${material.slice(1)} asteroid`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="68" height="68" viewBox="-34 -34 68 68" fill="none" stroke="${PALETTE.ROID}" stroke-width="1" stroke-linejoin="round"><title>${title}</title><polygon points="${points}"/>${details}</svg>\n`;
}
