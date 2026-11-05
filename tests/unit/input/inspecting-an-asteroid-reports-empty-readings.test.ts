import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AsteroidData, AsteroidProbe } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { Roid } from '../../../src/entities/roid/Roid';
import { chooseObjectAction, objectMenuAt } from '../../../src/input/objectActions';
import {
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../../../src/network/services/asteroidFieldSync';
import { canvasManager } from '../../../src/rendering/canvasSurface';

let pilot: Player;
let belt: Roid[];

function surveyProbe(health: number): AsteroidProbe {
  return {
    id: 'probe',
    ownerId: 'scout',
    health,
    maxHealth: 40,
    attachedAt: 1000,
    expiresAt: 301000,
    angle: 0,
    radialOffset: 40,
  };
}

function rock(overrides: Partial<AsteroidData>): Roid {
  return new Roid({
    id: 'inspected-rock',
    position: { x: 600, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 30,
    rotation: 0,
    angularVelocity: 0,
    health: 30,
    maxHealth: 30,
    vertices: 6,
    offsets: [1, 1, 1, 1, 1, 1],
    jaggedness: 0,
    ...overrides,
  });
}

/** Hold the rock under the cursor and choose Inspect, as a pilot does. */
function inspect(target: Roid): string {
  belt = [target];
  const menu = objectMenuAt(pilot, 700, 300);
  expect(menu.target.id).toBe(target.id);
  // The menu itself carries only the hull; the readout is built when Inspect is chosen.
  expect(menu.target.detail).toBe(`Hull ${Math.ceil(target.health)} / ${target.maxHealth}`);
  return chooseObjectAction(pilot, menu.target, 'inspect');
}

beforeEach(() => {
  pilot = new Player({ id: 'pilot', name: 'Pilot', type: 'local' });
  pilot.ship.position = { x: 300, y: 0 };
  belt = [];
  bindAsteroidFieldApply({
    readBelt: () => belt,
    onCreated: () => undefined,
    onUpdated: () => undefined,
    onDestroyed: () => undefined,
    onReconciled: () => undefined,
  });
  const canvas = document.createElement('canvas');
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
  vi.spyOn(canvasManager, 'readInputScale').mockReturnValue(1);
});

afterEach(() => {
  unbindAsteroidFieldApply();
  vi.restoreAllMocks();
});

test('an ordinary unsurveyed rock reads as examined: hull, no survey yet and no anomalies', () => {
  expect(inspect(rock({ material: 'metal', ore: 'metal' }))).toBe(
    'Asteroid: Hull 30 / 30 · Deposit unsurveyed · No anomalies'
  );
  // Fragments of an unsurveyed rock carry its ore with an empty survey list.
  expect(inspect(rock({ material: 'metal', ore: 'metal', surveyedBy: [] }))).toBe(
    'Asteroid: Hull 30 / 30 · Deposit unsurveyed · No anomalies'
  );
});

test('a crew survey reveals the deposit, including a barren result', () => {
  expect(inspect(rock({ material: 'ice', ore: 'ice', surveyedBy: ['crew'] }))).toBe(
    'Asteroid: Hull 30 / 30 · Ice ore · No anomalies'
  );
  expect(inspect(rock({ material: 'metal', ore: null, surveyedBy: ['crew'] }))).toBe(
    'Asteroid: Hull 30 / 30 · No ore · No anomalies'
  );
});

test('visible phenomena replace the empty anomaly reading', () => {
  expect(
    inspect(
      rock({
        health: 12.2,
        phenomenon: { kind: 'reflective', clusterId: 'mirror', energy: 0, maxEnergy: 3 },
        glowtoy: { charge: 0.2, cachePosition: { x: 0, y: 0 }, cacheRevealed: false },
      })
    )
  ).toBe('Asteroid: Hull 13 / 30 · Deposit unsurveyed · Reflective faces · Phosphorescent');
});

test('ridden, coupled and probed rocks list each attachment in order', () => {
  expect(
    inspect(
      rock({
        contourRider: { height: 0, direction: 1 },
        boost: { phase: 'armed', ownerId: 'hauler', angle: 0 },
        probe: surveyProbe(40),
      })
    )
  ).toBe(
    'Asteroid: Hull 30 / 30 · Deposit unsurveyed · Riding a contour · Boost Coupling attached · Survey Probe attached'
  );
});

test('a destroyed Survey Probe no longer counts as an anomaly', () => {
  expect(inspect(rock({ probe: surveyProbe(0) }))).toBe(
    'Asteroid: Hull 30 / 30 · Deposit unsurveyed · No anomalies'
  );
});

test('a glowtoy that dims while its menu is open reads as out of sight', () => {
  const crystal = rock({
    material: 'crystal',
    ore: 'crystal',
    surveyedBy: ['crew'],
    glowtoy: { charge: 0.5, cachePosition: { x: 0, y: 0 }, cacheRevealed: false },
  });
  belt = [crystal];
  const menu = objectMenuAt(pilot, 700, 300);
  expect(menu.target.id).toBe(crystal.id);
  crystal.glowtoy = { charge: 0, cachePosition: { x: 0, y: 0 }, cacheRevealed: false };
  expect(chooseObjectAction(pilot, menu.target, 'inspect')).toBe('Asteroid: Out of sight');
});

test('a rock destroyed while its menu is open reads as out of sight', () => {
  const doomed = rock({});
  belt = [doomed];
  const menu = objectMenuAt(pilot, 700, 300);
  belt = [];
  expect(chooseObjectAction(pilot, menu.target, 'inspect')).toBe('Asteroid: Out of sight');
});

test('a rock that leaves the screen while its menu is open reads as out of sight', () => {
  const drifting = rock({});
  belt = [drifting];
  const menu = objectMenuAt(pilot, 700, 300);
  pilot.ship.position = { x: 5000, y: 0 };
  expect(chooseObjectAction(pilot, menu.target, 'inspect')).toBe('Asteroid: Out of sight');
});
