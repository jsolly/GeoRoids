import type { HaulerUtilityId, ShipKitId } from '../../../shared-types';
import { parseShipKitId, SHIP_HULL_STYLE, type SHIP_HULL_TOPOLOGY } from './shipKits';

/** Local hull space: +f is forward, +p matches the classic triangle's rearLeft axis. */
interface HullLocalPoint {
  f: number;
  p: number;
}

interface HullPolyline {
  points: readonly HullLocalPoint[];
  closed: boolean;
}

type HullTopology = (typeof SHIP_HULL_TOPOLOGY)[ShipKitId];

interface HullOutline {
  kitId: ShipKitId;
  topology: HullTopology;
  hull: HullPolyline;
  extras: readonly HullPolyline[];
  thruster: HullLocalPoint;
  nozzles: readonly HullLocalPoint[];
}

const HULL_SVG_VIEWBOX = 64;
const HULL_SVG_PADDING = 5;
export const HULL_SVG_PACK_DIR = 'georoids-art/ships-v2';

function path(closed: boolean, coords: readonly number[]): HullPolyline {
  const points: HullLocalPoint[] = [];
  for (let i = 0; i < coords.length; i += 2) {
    const f = coords[i];
    const p = coords[i + 1];
    if (f === undefined || p === undefined) {
      throw new Error('hull path requires f,p pairs');
    }
    points.push({ f, p });
  }
  if (points.length < 2) {
    throw new Error('hull path needs at least two points');
  }
  return { closed, points };
}

function oval(cf: number, cp: number, rf: number, rp: number, steps = 10): HullPolyline {
  const coords: number[] = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
    coords.push(cf + Math.cos(angle) * rf, cp + Math.sin(angle) * rp);
  }
  return path(true, coords);
}

function flipP(line: HullPolyline): HullPolyline {
  return {
    closed: line.closed,
    points: line.points.map((point) => ({ f: point.f, p: -point.p })),
  };
}

function kitOutline(
  kitId: ShipKitId,
  topology: HullTopology,
  hull: HullPolyline,
  extras: readonly HullPolyline[],
  nozzles: readonly HullLocalPoint[]
): HullOutline {
  const thruster = nozzles[0];
  if (!thruster) {
    throw new Error(`${kitId} needs a thruster nozzle`);
  }
  return { kitId, topology, hull, extras, thruster, nozzles };
}

/** Twin forward towers, cargo yoke, and two engine bells. Traced from the hangar sheet. */
const HAULER_LEFT_TOWER_SLOT = path(true, [0.74, -0.6, 0.74, -0.5, 0.28, -0.5, 0.28, -0.6]);
const HAULER_LEFT_ENGINE_INNER = oval(-0.78, -0.86, 0.1, 0.11, 8);
const HAULER_LEFT_SHOULDER = path(true, [-0.24, -0.92, -0.14, -0.92, -0.14, -0.8, -0.24, -0.8]);

const HAULER_CARGO_YOKE: HullOutline = kitOutline(
  'hauler',
  'cargo-yoke',
  path(
    true,
    [
      0.898, -0.711, 0.898, -0.54, 0.803, -0.452, 0.063, -0.452, -0.06, -0.332, -0.06, -0.227,
      0.077, -0.114, 0.077, 0.114, -0.06, 0.223, -0.06, 0.329, 0.063, 0.452, 0.803, 0.452, 0.898,
      0.54, 0.888, 0.721, 0.643, 0.915, 0.107, 0.885, 0.08, 0.936, -0.009, 0.936, -0.216, 1.12,
      -0.547, 1.12, -0.636, 1.011, -0.847, 1.007, -0.898, 0.881, -0.868, 0.697, -0.813, 0.653,
      -0.632, 0.66, -0.632, 0.588, -0.704, 0.547, -0.704, 0.394, -0.786, 0.319, -0.786, -0.319,
      -0.704, -0.397, -0.704, -0.547, -0.632, -0.588, -0.632, -0.663, -0.81, -0.653, -0.868, -0.697,
      -0.898, -0.881, -0.847, -1.007, -0.803, -1.028, -0.636, -1.014, -0.547, -1.12, -0.216, -1.12,
      -0.009, -0.936, 0.08, -0.936, 0.101, -0.885, 0.643, -0.915,
    ]
  ),
  [
    path(
      true,
      [
        -0.18, -0.34, -0.14, -0.4, -0.14, 0.4, -0.18, 0.34, -0.6, 0.34, -0.66, 0.24, -0.66, -0.24,
        -0.6, -0.34,
      ]
    ),
    path(
      true,
      [
        -0.24, -0.26, -0.22, -0.32, -0.22, 0.32, -0.24, 0.26, -0.54, 0.26, -0.58, 0.18, -0.58,
        -0.18, -0.54, -0.26,
      ]
    ),
    HAULER_LEFT_TOWER_SLOT,
    flipP(HAULER_LEFT_TOWER_SLOT),
    HAULER_LEFT_ENGINE_INNER,
    flipP(HAULER_LEFT_ENGINE_INNER),
    HAULER_LEFT_SHOULDER,
    flipP(HAULER_LEFT_SHOULDER),
  ],
  [
    { f: -0.9, p: -0.88 },
    { f: -0.9, p: 0.88 },
  ]
);

/** Interchangeable hardware in the central bay between the Hauler's towers. */
const HAULER_EQUIPMENT: Record<HaulerUtilityId, readonly HullPolyline[]> = {
  boost_coupling: [
    // Fuel chamber and flared nozzle use the same central utility mount.
    path(true, [0.03, -0.2, 0.3, -0.2, 0.3, 0.2, 0.03, 0.2]),
    path(false, [0.13, -0.2, 0.13, 0.2]),
    path(true, [0.3, -0.08, 0.52, -0.08, 0.72, -0.22, 0.72, 0.22, 0.52, 0.08, 0.3, 0.08]),
  ],
  tow_cable: [
    // Winch frame and visibly wound cable across its drum.
    path(true, [0.03, -0.2, 0.25, -0.2, 0.25, 0.2, 0.03, 0.2]),
    path(
      false,
      [
        0.04, -0.12, 0.24, -0.12, 0.04, -0.04, 0.24, -0.04, 0.04, 0.04, 0.24, 0.04, 0.04, 0.12,
        0.24, 0.12,
      ]
    ),
    // Exposed cable ending in a curved open tow hook.
    path(false, [0.25, 0, 0.37, 0, 0.44, 0.03, 0.52, 0.03, 0.58, 0]),
    path(false, [0.58, 0, 0.67, 0, 0.72, -0.06, 0.7, -0.13, 0.64, -0.16, 0.59, -0.13, 0.59, -0.08]),
  ],
  resource_tap: [
    // Extractor housing and a long toothed probe, on the same mount.
    path(true, [0.03, -0.2, 0.25, -0.2, 0.31, -0.12, 0.31, 0.12, 0.25, 0.2, 0.03, 0.2]),
    path(false, [0.14, -0.2, 0.14, 0.2]),
    path(true, [0.31, -0.09, 0.55, -0.09, 0.72, 0, 0.55, 0.09, 0.31, 0.09]),
    path(false, [0.36, -0.09, 0.42, 0.09, 0.46, -0.09, 0.52, 0.09, 0.56, -0.08]),
  ],
};

export function getHaulerEquipment(utility: HaulerUtilityId): readonly HullPolyline[] {
  return HAULER_EQUIPMENT[utility];
}

const SURVEYOR_LEFT_WING_PANEL = path(false, [0.2, -0.95, 0.0, -0.4, -0.22, -0.48]);

/** Forward dish, delta wings, and a single aft bell. Traced from the hangar sheet. */
const SURVEYOR_DELTA_WING: HullOutline = kitOutline(
  'surveyor',
  'delta-wing',
  path(
    true,
    [
      0.559, -0.015, 0.54, 0.034, 0.474, 0.025, 0.471, 0.204, 0.357, 0.162, 0.288, 0.054, 0.265,
      0.051, 0.167, 0.126, 0.072, 0.165, 0.062, 0.234, -0.043, 0.312, -0.072, 0.427, -0.059, 0.538,
      0.128, 0.986, 0.222, 1.081, 0.327, 1.055, 0.357, 1.085, 0.353, 1.127, 0.317, 1.15, 0.262,
      1.121, 0.085, 1.137, 0.046, 1.107, 0.029, 1.055, -0.53, 0.371, -0.523, 0.335, -0.458, 0.329,
      -0.393, 0.247, -0.357, 0.159, -0.357, 0.116, -0.383, 0.087, -0.517, 0.1, -0.559, 0.07, -0.553,
      -0.08, -0.517, -0.103, -0.406, -0.103, -0.383, -0.087, -0.357, -0.119, -0.393, -0.25, -0.468,
      -0.339, -0.523, -0.339, -0.53, -0.375, 0.043, -1.075, 0.059, -1.121, 0.085, -1.14, 0.265,
      -1.124, 0.288, -1.15, 0.33, -1.15, 0.357, -1.121, 0.34, -1.065, 0.291, -1.058, 0.262, -1.085,
      0.222, -1.085, 0.131, -0.996, -0.059, -0.541, -0.069, -0.394, -0.039, -0.312, 0.059, -0.24,
      0.069, -0.172, 0.17, -0.126, 0.216, -0.077, 0.285, -0.051, 0.357, -0.165, 0.471, -0.208,
      0.474, -0.025, 0.533, -0.038,
    ]
  ),
  [
    oval(0.02, 0, 0.16, 0.08, 10),
    oval(-0.02, 0, 0.09, 0.045, 8),
    path(true, [-0.14, -0.04, -0.14, 0.04, -0.18, 0.04, -0.18, -0.04]),
    SURVEYOR_LEFT_WING_PANEL,
    flipP(SURVEYOR_LEFT_WING_PANEL),
    oval(-0.46, 0, 0.05, 0.045, 8),
  ],
  [{ f: -0.56, p: 0 }]
);

const V2_HULL_OUTLINES: Record<ShipKitId, HullOutline> = {
  surveyor: SURVEYOR_DELTA_WING,
  hauler: HAULER_CARGO_YOKE,
};

export function getKitHullOutline(kitId: unknown): HullOutline {
  return V2_HULL_OUTLINES[parseShipKitId(kitId)];
}

export function listKitHullOutlines(): HullOutline[] {
  return (Object.keys(V2_HULL_OUTLINES) as ShipKitId[]).map((id) => V2_HULL_OUTLINES[id]);
}

export function projectHullPoint(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  point: HullLocalPoint
): { x: number; y: number } {
  return {
    x: centerX + radius * (point.f * Math.cos(angle) + point.p * Math.sin(angle)),
    y: centerY + radius * (-point.f * Math.sin(angle) + point.p * Math.cos(angle)),
  };
}

export function projectHullPolyline(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  line: HullPolyline
): { x: number; y: number }[] {
  return line.points.map((point) => projectHullPoint(centerX, centerY, radius, angle, point));
}

function hullPolylineEdges(
  points: readonly { x: number; y: number }[],
  closed: boolean
): [{ x: number; y: number }, { x: number; y: number }][] {
  const edges: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a && b) {
      edges.push([a, b]);
    }
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (closed && points.length > 2 && first && last) {
    edges.push([last, first]);
  }
  return edges;
}

export function projectKitHullEdges(
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  kitId: unknown
): [{ x: number; y: number }, { x: number; y: number }][] {
  const outline = getKitHullOutline(kitId);
  const edges = hullPolylineEdges(
    projectHullPolyline(centerX, centerY, radius, angle, outline.hull),
    outline.hull.closed
  );
  for (const extra of outline.extras) {
    edges.push(
      ...hullPolylineEdges(
        projectHullPolyline(centerX, centerY, radius, angle, extra),
        extra.closed
      )
    );
  }
  return edges;
}

function roundSvgCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function outlineBounds(outline: HullOutline): {
  minF: number;
  maxF: number;
  minP: number;
  maxP: number;
} {
  let minF = Number.POSITIVE_INFINITY;
  let maxF = Number.NEGATIVE_INFINITY;
  let minP = Number.POSITIVE_INFINITY;
  let maxP = Number.NEGATIVE_INFINITY;
  for (const line of [outline.hull, ...outline.extras]) {
    for (const point of line.points) {
      minF = Math.min(minF, point.f);
      maxF = Math.max(maxF, point.f);
      minP = Math.min(minP, point.p);
      maxP = Math.max(maxP, point.p);
    }
  }
  return { minF, maxF, minP, maxP };
}

function hullLocalToSvg(
  point: HullLocalPoint,
  fit: { midF: number; midP: number; scale: number }
): { x: number; y: number } {
  return {
    x: roundSvgCoord(HULL_SVG_VIEWBOX / 2 + (point.p - fit.midP) * fit.scale),
    y: roundSvgCoord(HULL_SVG_VIEWBOX / 2 - (point.f - fit.midF) * fit.scale),
  };
}

function hullPolylineToSvgPath(
  line: HullPolyline,
  fit: { midF: number; midP: number; scale: number }
): string {
  const projected = line.points.map((point) => hullLocalToSvg(point, fit));
  const first = projected[0];
  if (!first) {
    return '';
  }
  let d = `M${first.x} ${first.y}`;
  for (let i = 1; i < projected.length; i++) {
    const point = projected[i];
    if (point) {
      d += ` L${point.x} ${point.y}`;
    }
  }
  if (line.closed) {
    d += ' Z';
  }
  return d;
}

interface HullSvgOptions {
  background?: boolean;
  title?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function serializeKitHullSvg(kitId: unknown, options: HullSvgOptions = {}): string {
  const outline = getKitHullOutline(kitId);
  const includeBackground = options.background !== false;
  const includeTitle = options.title !== false;
  const width = options.width ?? HULL_SVG_VIEWBOX;
  const height = options.height ?? HULL_SVG_VIEWBOX;
  const classAttr = options.className ? ` class="${options.className}"` : '';
  const bounds = outlineBounds(outline);
  const spanF = Math.max(bounds.maxF - bounds.minF, 0.01);
  const spanP = Math.max(bounds.maxP - bounds.minP, 0.01);
  const usable = HULL_SVG_VIEWBOX - HULL_SVG_PADDING * 2;
  const fit = {
    midF: (bounds.minF + bounds.maxF) / 2,
    midP: (bounds.minP + bounds.maxP) / 2,
    scale: Math.min(usable / spanF, usable / spanP),
  };
  const paths = [
    outline.hull,
    ...outline.extras,
    ...(outline.kitId === 'hauler' ? getHaulerEquipment('tow_cable') : []),
  ]
    .map((line) => `    <path d="${hullPolylineToSvgPath(line, fit)}"/>`)
    .join('\n');
  const title = includeTitle ? `\n  <title>${outline.kitId} — ${outline.topology}</title>` : '';
  const background = includeBackground
    ? `\n  <rect width="${HULL_SVG_VIEWBOX}" height="${HULL_SVG_VIEWBOX}" fill="${SHIP_HULL_STYLE.background}"/>`
    : '';
  const header = includeBackground
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Hangar bake. Topology: ${outline.topology}. Source: src/entities/ship/hullOutlines.ts -->\n`
    : '';
  return `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HULL_SVG_VIEWBOX} ${HULL_SVG_VIEWBOX}" width="${width}" height="${height}" role="img" aria-label="${outline.kitId} ${outline.topology}"${classAttr}>${title}${background}
  <g fill="none" stroke="${SHIP_HULL_STYLE.stroke}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
${paths}
  </g>
</svg>
`;
}

export function kitHullPickerSvg(kitId: unknown): string {
  return serializeKitHullSvg(kitId, {
    background: false,
    title: false,
    width: 48,
    height: 36,
    className: 'ship-kit-silhouette',
  }).trim();
}

export function kitHullSvgFileName(kitId: ShipKitId): string {
  return `${kitId}.svg`;
}
