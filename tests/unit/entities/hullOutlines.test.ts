import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import {
  EO_OUTLINES,
  type EoOutlineId,
  serializeEoSatelliteSvg,
} from '../../../src/entities/satellite/eoOutlines';
import {
  getKitHullOutline,
  HULL_SVG_PACK_DIR,
  kitHullSvgFileName,
  listKitHullOutlines,
  projectHullPoint,
  serializeKitHullSvg,
} from '../../../src/entities/ship/hullOutlines';
import { SHIP_HULL_TOPOLOGY, SHIP_KIT_IDS } from '../../../src/entities/ship/shipKits';

const EO_SVG_PACK_DIR = 'georoids-art/eo-satellites';
const EO_SVG_FILE_NAMES: Record<EoOutlineId, string> = {
  'landsat-7': 'landsat-7.svg',
  terra: 'terra.svg',
  aqua: 'aqua.svg',
  'goes-16': 'goes-16.svg',
  envisat: 'envisat.svg',
  'worldview-3': 'worldview-3.svg',
};

test('each kit bakes a unique v2 topology', () => {
  const outlines = listKitHullOutlines();
  expect(outlines.map((outline) => outline.kitId)).toEqual([...SHIP_KIT_IDS]);
  expect(new Set(outlines.map((outline) => outline.topology)).size).toBe(2);
  expect(SHIP_HULL_TOPOLOGY).toEqual({
    surveyor: 'needle',
    hauler: 'barge-hex',
  });
  const fingerprints = outlines.map((outline) =>
    outline.hull.points.map((point) => `${point.f}:${point.p}`).join('|')
  );
  expect(new Set(fingerprints).size).toBe(2);
});

test('Surveyor needle keeps two tail fins around its inverted-V aft notch', () => {
  const surveyor = getKitHullOutline('surveyor');
  expect(surveyor.topology).toBe('needle');
  expect(surveyor.hull.points).toHaveLength(6);
  const minF = Math.min(...surveyor.hull.points.map((point) => point.f));
  const wings = surveyor.hull.points.filter((point) => point.f === minF);
  expect(wings).toHaveLength(2);
  const notch = surveyor.hull.points.find(
    (point) => point.p === 0 && point.f > minF && point.f < 0
  );
  expect(notch).toBeTruthy();
});

test('Hauler barge is squat with a pointed bow, bevelled sides, and a flat keel', () => {
  const hauler = getKitHullOutline('hauler');
  expect(hauler.topology).toBe('barge-hex');
  const minF = Math.min(...hauler.hull.points.map((point) => point.f));
  const maxF = Math.max(...hauler.hull.points.map((point) => point.f));
  const maxP = Math.max(...hauler.hull.points.map((point) => Math.abs(point.p)));
  const keel = hauler.hull.points.filter((point) => point.f === minF);
  expect(keel).toHaveLength(2);
  const bow = hauler.hull.points.reduce((best, point) => (point.f > best.f ? point : best));
  expect(bow.p).toBe(0);
  expect(maxP * 2).toBeGreaterThan(maxF - minF);
  const widest = hauler.hull.points.filter((point) => Math.abs(point.p) > 1);
  expect(widest).toHaveLength(2);
  expect(widest.every((point) => point.f > minF && point.f < maxF)).toBe(true);
});

test('v2 SVG pack matches the outline bake and names no v1 sheets', () => {
  for (const outline of listKitHullOutlines()) {
    const fileName = kitHullSvgFileName(outline.kitId);
    const onDisk = readFileSync(resolve(process.cwd(), HULL_SVG_PACK_DIR, fileName), 'utf8');
    expect(onDisk).toBe(serializeKitHullSvg(outline.kitId));
    expect(onDisk).toContain(outline.topology);
    expect(onDisk).not.toMatch(/v1/i);
    expect(onDisk).toContain('#5EEAD4');
    expect(onDisk).toContain('#000011');
  }
});

test('EO SVG pack matches the authored hardware outlines and keeps the neutral hull stroke', () => {
  for (const typeId of Object.keys(EO_OUTLINES) as EoOutlineId[]) {
    const onDisk = readFileSync(
      resolve(process.cwd(), EO_SVG_PACK_DIR, EO_SVG_FILE_NAMES[typeId]),
      'utf8'
    );
    expect(onDisk).toBe(serializeEoSatelliteSvg(typeId));
    expect(onDisk).toContain('#C4B5FD');
    expect(onDisk).toContain('fill="none"');
  }
});

test('local-space projection matches the classic triangle helper axes', () => {
  const nose = projectHullPoint(0, 0, 10, 0, { f: 1, p: 0 });
  expect(nose).toEqual({ x: 10, y: 0 });
  const rearLeft = projectHullPoint(0, 0, 10, 0, { f: -0.8, p: 0.5 });
  expect(rearLeft).toEqual({ x: -8, y: 5 });
});
