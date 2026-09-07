import type { ShipKitId } from '../../../shared-types';
import { AD_V2_HULL_SHEET, type AD_V2_HULL_TOPOLOGY, parseShipKitId } from './shipKits';

/** Local hull space: +f is forward, +p matches the classic triangle's rearLeft axis. */
export interface HullLocalPoint {
  f: number;
  p: number;
}

export interface HullPolyline {
  points: readonly HullLocalPoint[];
  closed: boolean;
}

export type HullTopology = (typeof AD_V2_HULL_TOPOLOGY)[ShipKitId];

export interface HullOutline {
  kitId: ShipKitId;
  topology: HullTopology;
  hull: HullPolyline;
  extras: readonly HullPolyline[];
  thruster: HullLocalPoint;
}

export const HULL_SVG_VIEWBOX = 64;
export const HULL_SVG_CENTER = { x: 32, y: 34 } as const;
export const HULL_SVG_SCALE = 20;
export const HULL_SVG_PACK_DIR = 'georoids-art/ships-v2';

/** Traced from the recovered 1100×720 AD v2 contact sheet; 80 source pixels per hull unit. */

const DART_NEEDLE: HullOutline = {
  kitId: 'dart',
  topology: 'needle',
  hull: {
    closed: true,
    points: [
      { f: 1.2375, p: 0.0 },
      { f: -1.025, p: -0.1625 },
      { f: -1.2375, p: -0.0625 },
      { f: -0.85, p: 0.0 },
      { f: -1.2375, p: 0.0625 },
      { f: -1.05, p: 0.1625 },
    ],
  },
  extras: [],
  thruster: { f: -0.85, p: 0.0 },
};

const HAULER_BARGE_HEX: HullOutline = {
  kitId: 'hauler',
  topology: 'barge-hex',
  hull: {
    closed: true,
    points: [
      { f: 0.8375, p: 0.0 },
      { f: 0.2875, p: -1.0 },
      { f: -0.4125, p: -1.1 },
      { f: -0.85, p: -0.5125 },
      { f: -0.85, p: 0.5 },
      { f: -0.425, p: 1.1 },
      { f: 0.2875, p: 1.0 },
    ],
  },
  extras: [],
  thruster: { f: -0.85, p: 0.0 },
};

const WARDEN_DELTA: HullOutline = {
  kitId: 'warden',
  topology: 'delta-shield-arc',
  hull: {
    closed: true,
    points: [
      { f: 1.025, p: 0.0125 },
      { f: -0.9125, p: -0.6125 },
      { f: -0.9125, p: -0.2125 },
      { f: -0.575, p: 0.0 },
      { f: -0.9125, p: 0.2125 },
      { f: -0.9125, p: 0.6125 },
    ],
  },
  extras: [
    {
      closed: false,
      points: [
        { f: 1.2375, p: -0.45 },
        { f: 1.35, p: -0.3125 },
        { f: 1.4125, p: -0.1625 },
        { f: 1.425, p: 0.0 },
        { f: 1.3875, p: 0.1875 },
        { f: 1.325, p: 0.35 },
        { f: 1.2375, p: 0.45 },
      ],
    },
  ],
  thruster: { f: -0.575, p: 0.0 },
};

const SKIRMISHER_Y_FORK: HullOutline = {
  kitId: 'skirmisher',
  topology: 'y-fork',
  hull: {
    closed: true,
    points: [
      { f: 1.1125, p: -0.375 },
      { f: 0.175, p: -0.2125 },
      { f: -0.3, p: 0.0 },
      { f: 0.175, p: 0.2125 },
      { f: 1.1125, p: 0.3875 },
      { f: 0.4375, p: 0.5 },
      { f: -0.325, p: 0.4 },
      { f: -1.075, p: 0.2875 },
      { f: -0.7, p: 0.0 },
      { f: -1.075, p: -0.275 },
      { f: -0.325, p: -0.4125 },
      { f: 0.4375, p: -0.5 },
    ],
  },
  extras: [],
  thruster: { f: -0.7, p: 0.0 },
};

const QUAKE_TERRACED_MOUNTAIN: HullOutline = {
  kitId: 'quake',
  topology: 'terraced-mountain',
  hull: {
    closed: true,
    points: [
      { f: 0.95, p: 0.0 },
      { f: 0.2875, p: -0.275 },
      { f: 0.2875, p: -0.7875 },
      { f: -0.0375, p: -0.7875 },
      { f: -0.0375, p: -1.1 },
      { f: -0.3625, p: -1.1 },
      { f: -0.3625, p: -0.5 },
      { f: -0.9125, p: -0.5 },
      { f: -0.9125, p: 0.5 },
      { f: -0.3625, p: 0.5 },
      { f: -0.3625, p: 1.1125 },
      { f: -0.0375, p: 1.1125 },
      { f: -0.0375, p: 0.775 },
      { f: 0.2875, p: 0.775 },
      { f: 0.2875, p: 0.2875 },
    ],
  },
  extras: [],
  thruster: { f: -0.9125, p: 0.0 },
};

const V2_HULL_OUTLINES: Record<ShipKitId, HullOutline> = {
  dart: DART_NEEDLE,
  hauler: HAULER_BARGE_HEX,
  warden: WARDEN_DELTA,
  skirmisher: SKIRMISHER_Y_FORK,
  quake: QUAKE_TERRACED_MOUNTAIN,
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

export function hullPolylineEdges(
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

export function roundSvgCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

export function hullLocalToSvg(point: HullLocalPoint): { x: number; y: number } {
  return {
    x: roundSvgCoord(HULL_SVG_CENTER.x + point.p * HULL_SVG_SCALE),
    y: roundSvgCoord(HULL_SVG_CENTER.y - point.f * HULL_SVG_SCALE),
  };
}

export function hullPolylineToSvgPath(line: HullPolyline): string {
  const projected = line.points.map(hullLocalToSvg);
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

export interface HullSvgOptions {
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
  const paths = [outline.hull, ...outline.extras]
    .map((line) => `    <path d="${hullPolylineToSvgPath(line)}"/>`)
    .join('\n');
  const title = includeTitle ? `\n  <title>${outline.kitId} — ${outline.topology}</title>` : '';
  const background = includeBackground
    ? `\n  <rect width="${HULL_SVG_VIEWBOX}" height="${HULL_SVG_VIEWBOX}" fill="${AD_V2_HULL_SHEET.background}"/>`
    : '';
  const header = includeBackground
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!-- AD v2 bake. Topology: ${outline.topology}. Source: src/entities/ship/hullOutlines.ts -->\n`
    : '';
  return `${header}<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${HULL_SVG_VIEWBOX} ${HULL_SVG_VIEWBOX}" width="${width}" height="${height}" role="img" aria-label="${outline.kitId} ${outline.topology}"${classAttr}>${title}${background}
  <g fill="none" stroke="${AD_V2_HULL_SHEET.stroke}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
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
