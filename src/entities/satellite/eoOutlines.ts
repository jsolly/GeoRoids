/** Authored EO hardware outlines, shared by the canvas renderer and exported SVG pack. */
export interface EoOutline {
  readonly name: string;
  readonly lines: readonly (readonly number[])[];
  /** Center x/y and horizontal/vertical radii. */
  readonly ellipses: readonly (readonly [number, number, number, number])[];
  readonly muzzle: readonly [number, number];
}

export const EO_OUTLINES = {
  'landsat-7': {
    name: 'Landsat 7',
    lines: [
      [-15, -7, -6, -12, 3, -8, 6, -3, 6, 7, -3, 12, -14, 8, -15, -7],
      [-6, -12, -5, 7, -14, 8],
      [-5, 7, 6, 7],
      [6, 1, 10, 1],
      [10, -5, 30, -5, 30, 7, 10, 7, 10, -5],
      [15, -5, 15, 7],
      [20, -5, 20, 7],
      [25, -5, 25, 7],
      [-3, 12, -3, 17],
    ],
    ellipses: [[0, -2, 3.5, 5]],
    muzzle: [-3, 17],
  },
  terra: {
    name: 'Terra',
    lines: [
      [-20, -5, -14, -11, 0, -11, 7, -5, 7, 11, -14, 11, -20, 5, -20, -5],
      [-14, -11, -14, 11],
      [-14, -5, 7, -5],
      [0, -11, 8, -20, 16, -18, 23, -23, 31, -21, 25, -7, 18, -2, 11, -5, 7, 0],
      [8, -20, 11, -5],
      [16, -18, 18, -2],
      [23, -23, 25, -7],
      [-10, 11, -10, 17],
      [-3, 11, -3, 17],
    ],
    ellipses: [
      [-10, 17, 2.5, 2],
      [-3, 17, 2.5, 2],
    ],
    muzzle: [-6.5, 20],
  },
  aqua: {
    name: 'Aqua',
    lines: [
      [-6, 7, 1, 3, 11, 6, 15, 13, 10, 20, -3, 18, -6, 7],
      [-29, 2, -10, 2, -10, 11, -29, 11, -29, 2],
      [-24, 2, -24, 11],
      [-19, 2, -19, 11],
      [-14, 2, -14, 11],
      [-10, 7, -6, 9],
      [6, 6, 8, -1],
      [0, -8, 8, -1, 17, -8],
      [8, -8, 12, -16],
      [11, 10, 20, 10],
    ],
    ellipses: [[8, -8, 10, 6]],
    muzzle: [12, -16],
  },
  'goes-16': {
    name: 'GOES-16',
    lines: [
      [0, -6, 8, -11, 16, -6, 16, 8, 8, 13, 0, 8, 0, -6],
      [8, -11, 8, 1, 16, 8],
      [-30, -16, -5, -16, -5, 4, -30, 4, -30, -16],
      [-25, -16, -25, 4],
      [-20, -16, -20, 4],
      [-15, -16, -15, 4],
      [-10, -16, -10, 4],
      [-5, -5, 0, -3],
      [16, 3, 30, 24],
      [27, 25, 31, 22],
      [7, 13, 7, 19],
    ],
    ellipses: [[5, 5, 3.5, 4]],
    muzzle: [7, 19],
  },
  envisat: {
    name: 'ENVISAT',
    lines: [
      [-5, -8, 4, -13, 12, -8, 12, 13, 3, 18, -5, 13, -5, -8],
      [4, -13, 4, 10, 12, 13],
      [-30, -13, -10, -13, -10, 12, -30, 12, -30, -13],
      [-20, -13, -20, 12],
      [-30, -1, -10, -1],
      [-10, 0, -5, 0],
      [20, -29, 27, -29, 27, 29, 20, 29, 20, -29],
      [20, -10, 27, -10],
      [20, 10, 27, 10],
      [12, 1, 20, 1],
      [3, 18, 3, 23],
    ],
    ellipses: [],
    muzzle: [27, 1],
  },
  'worldview-3': {
    name: 'WorldView-3',
    lines: [
      [-6, -24, -6, 9, -10, 16, -6, 24, 6, 24, 10, 16, 6, 9, 6, -24],
      [-6, 9, 6, 9],
      [-10, 16, 10, 16],
      [-22, -4, -10, -4, -10, 6, -22, 6, -22, -4],
      [10, -4, 22, -4, 22, 6, 10, 6, 10, -4],
      [-16, -4, -16, 6],
      [16, -4, 16, 6],
      [-10, 1, -6, 1],
      [6, 1, 10, 1],
      [0, -27, 0, -31],
    ],
    ellipses: [[0, -24, 6, 3]],
    muzzle: [0, -31],
  },
} as const satisfies Record<string, EoOutline>;

export type EoOutlineId = keyof typeof EO_OUTLINES;
export const EO_HULL_COLOR = '#C4B5FD';
export const EO_SHOT_COLOR = '#E9D5FF';

export function drawEoSatelliteOutline(
  ctx: CanvasRenderingContext2D,
  typeId: EoOutlineId,
  radius: number,
  angle: number,
  color: string,
  firing: boolean
): void {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(angle)) {
    return;
  }
  const outline: EoOutline = EO_OUTLINES[typeId];
  if (!outline) {
    return;
  }
  const scale = radius / 32;
  ctx.save();
  ctx.rotate(-angle);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15 / scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const line of outline.lines) {
    ctx.moveTo(line[0] ?? 0, line[1] ?? 0);
    for (let i = 2; i < line.length; i += 2) {
      ctx.lineTo(line[i] ?? 0, line[i + 1] ?? 0);
    }
  }
  for (const [x, y, rx, ry] of outline.ellipses) {
    ctx.moveTo(x + rx, y);
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  if (firing) {
    const [x, y] = outline.muzzle;
    ctx.strokeStyle = EO_SHOT_COLOR;
    ctx.beginPath();
    ctx.moveTo(x - 1.5, y);
    ctx.lineTo(x + 1.5, y);
    ctx.stroke();
  }
  ctx.restore();
}

export function serializeEoSatelliteSvg(typeId: EoOutlineId): string {
  const outline: EoOutline = EO_OUTLINES[typeId];
  const paths = outline.lines.map((line) => {
    const points = [];
    for (let i = 0; i < line.length; i += 2) {
      points.push(`${line[i]},${line[i + 1]}`);
    }
    return `    <polyline points="${points.join(' ')}"/>`;
  });
  const ellipses = outline.ellipses.map(
    ([cx, cy, rx, ry]) => `    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-34 -34 68 68" width="68" height="68" role="img" aria-label="${outline.name}">\n  <title>${outline.name}</title>\n  <g fill="none" stroke="${EO_HULL_COLOR}" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">\n${[...paths, ...ellipses].join('\n')}\n  </g>\n</svg>\n`;
}
