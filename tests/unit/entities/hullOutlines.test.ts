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

test('each kit bakes a unique hangar topology', () => {
  const outlines = listKitHullOutlines();
  expect(outlines.map((outline) => outline.kitId)).toEqual([...SHIP_KIT_IDS]);
  expect(new Set(outlines.map((outline) => outline.topology)).size).toBe(2);
  expect(SHIP_HULL_TOPOLOGY).toEqual({
    surveyor: 'delta-wing',
    hauler: 'cargo-yoke',
  });
  const fingerprints = outlines.map((outline) =>
    outline.hull.points.map((point) => `${point.f}:${point.p}`).join('|')
  );
  expect(new Set(fingerprints).size).toBe(2);
});

test('Surveyor delta-wing keeps a forward dish, wide wings, and one aft nozzle', () => {
  const surveyor = getKitHullOutline('surveyor');
  expect(surveyor.topology).toBe('delta-wing');
  expect(surveyor.nozzles).toHaveLength(1);
  const hullF = surveyor.hull.points.map((point) => point.f);
  const hullP = surveyor.hull.points.map((point) => point.p);
  const maxF = Math.max(...hullF);
  const minF = Math.min(...hullF);
  const spanP = Math.max(...hullP) - Math.min(...hullP);
  expect(spanP).toBeGreaterThan(maxF - minF);
  const nose = surveyor.hull.points.reduce((best, point) => (point.f > best.f ? point : best));
  expect(Math.abs(nose.p)).toBeLessThan(0.05);
  const wings = surveyor.hull.points.filter((point) => Math.abs(point.p) > 1);
  expect(wings.length).toBeGreaterThan(4);
  expect(surveyor.extras.length).toBeGreaterThan(3);
});

test('Hauler yoke keeps twin forward towers, a cargo bay, and two aft engine bells', () => {
  const hauler = getKitHullOutline('hauler');
  expect(hauler.topology).toBe('cargo-yoke');
  expect(hauler.nozzles).toHaveLength(2);
  const maxF = Math.max(...hauler.hull.points.map((point) => point.f));
  const towers = hauler.hull.points.filter((point) => point.f > maxF - 0.05);
  expect(towers.some((point) => point.p < 0)).toBe(true);
  expect(towers.some((point) => point.p > 0)).toBe(true);
  const midForward = hauler.hull.points
    .filter((point) => Math.abs(point.p) < 0.2)
    .map((point) => point.f);
  expect(Math.max(...midForward)).toBeLessThan(maxF - 0.4);
  expect(hauler.nozzles.every((nozzle) => nozzle.f < 0 && Math.abs(nozzle.p) > 0.5)).toBe(true);
  expect(hauler.extras.length).toBeGreaterThan(5);
});

test('hangar SVG pack matches the outline bake and names no v1 sheets', () => {
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
