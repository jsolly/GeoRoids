import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { civicLot } from '../../../shared/furnaces';
import { Player } from '../../../src/entities/player/Player';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  chooseObjectAction,
  objectMenuAt,
  tickObjectApproach,
  worldPoint,
} from '../../../src/input/objectActions';
import {
  bindAsteroidFieldApply,
  unbindAsteroidFieldApply,
} from '../../../src/network/services/asteroidFieldSync';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import {
  resetWorldExploration,
  setWorldMapAssets,
  worldFurnaces,
} from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import * as townStore from '../../../src/runtime/townStore';

let pilot: Player;
beforeEach(() => {
  pilot = new Player({ id: 'pilot', name: 'Pilot', type: 'local' });
  pilot.ship.position = { x: 300, y: 0 };
  pilot.ship.angle = Math.PI;
  const canvas = document.createElement('canvas');
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 800, height: 600 });
  vi.spyOn(canvasManager, 'readInputScale').mockReturnValue(1);
});
afterEach(() => {
  resetWorldExploration();
  unbindAsteroidFieldApply();
  vi.restoreAllMocks();
});

test('visible furnace actions are available before ship contact, and execute only after approach', () => {
  const menu = objectMenuAt(pilot, 100, 300);
  expect(menu.target.id).toBe('town-square');
  expect(menu.actions.some((a) => a.action === 'enter')).toBe(true);
  const open = vi.spyOn(townStore, 'openTownStore').mockReturnValue(true);
  vi.spyOn(townStore, 'canEnterTownStore').mockImplementation(
    () => Math.hypot(pilot.ship.position.x, pilot.ship.position.y) < 85
  );
  chooseObjectAction(pilot, menu.target, 'enter');
  expect(open).not.toHaveBeenCalled();
  for (let tick = 0; tick < 300; tick++) {
    pilot.ship.update();
    tickObjectApproach(pilot);
  }
  expect(open).toHaveBeenCalledTimes(1);
  expect(pilot.ship.pendingObjectAction).toBeNull();
  expect(pilot.ship.velocity).toEqual({ x: 0, y: 0 });
});

test('camera conversion uses current zoom and hit targets have finger tolerance', () => {
  vi.spyOn(canvasManager, 'readInputScale').mockReturnValue(0.5);
  expect(worldPoint(pilot, 450, 350)).toEqual({ x: 400, y: 100 });
  const menu = objectMenuAt(pilot, 250, 300);
  expect(menu.target.id).toBe('town-square');
  const crew = new Player({ id: 'crew', name: 'Crew', type: 'remote' });
  crew.ship.position = { x: 400, y: 0 };
  vi.spyOn(ConnectionManager.getInstance(), 'getAllPlayers').mockReturnValue([pilot, crew]);
  expect(crew.ship.r * 0.5).toBeLessThan(20);
  const crewMenu = objectMenuAt(pilot, 470, 300);
  expect(crewMenu.target.id).toBe('crew');
  expect(chooseObjectAction(pilot, crewMenu.target, 'inspect')).toBe(
    `Crew: Crew · ${Math.ceil(crew.ship.health)} hull`
  );
  expect(objectMenuAt(pilot, 473, 300).target.kind).toBe('location');
});

test('an unlit action target cancels approach', () => {
  const target = {
    id: 'gone',
    kind: 'furnace' as const,
    name: 'Furnace',
    position: { x: 100, y: 0 },
    radius: 85,
    detail: '',
  };
  setWorldMapAssets([
    { id: target.id, kind: 'furnace', name: target.name, position: target.position },
  ]);
  chooseObjectAction(pilot, target, 'enter');
  tickObjectApproach(pilot);
  expect(pilot.ship.pendingObjectAction).toBeNull();
  expect(pilot.ship.navigation).toBeNull();
});

test('a funded Scout can approach a civic foundation from a genuine namespaced map row', () => {
  const lot = civicLot('street-1-0');
  if (!lot) {
    throw new Error('Missing civic fixture');
  }
  pilot.ship.position = { x: lot.position.x + 300, y: lot.position.y };
  pilot.score = lot.cost;
  setWorldMapAssets([
    { id: `furnace:${lot.id}`, kind: 'foundation', name: lot.name, position: lot.position },
  ]);
  const menu = objectMenuAt(pilot, 100, 300);
  expect(menu.target.id).toBe(lot.id);
  expect(menu.actions.find((action) => action.action === 'build')?.disabled).toBe(false);
  chooseObjectAction(pilot, menu.target, 'build');
  expect(pilot.ship.pendingObjectAction).toEqual({ id: lot.id, action: 'build' });
  expect(pilot.ship.navigation?.destination).toEqual(lot.position);
});

test('a nearby civic prompt reaches its lit furnace using the canonical ID', () => {
  const lot = civicLot('street-1-0');
  if (!lot) {
    throw new Error('Missing civic fixture');
  }
  worldFurnaces.replaceLit([{ id: lot.id, builderName: 'Crew' }]);
  pilot.ship.position = { ...lot.position };
  setWorldMapAssets([
    { id: `furnace:${lot.id}`, kind: 'furnace', name: lot.name, position: lot.position },
  ]);
  const open = vi.spyOn(townStore, 'openTownStore').mockReturnValue(true);
  vi.spyOn(townStore, 'canEnterTownStore').mockReturnValue(true);
  chooseObjectAction(pilot, { ...lot, kind: 'furnace', detail: lot.name }, 'enter');
  expect(open).toHaveBeenCalledOnce();
  expect(pilot.ship.pendingObjectAction).toBeNull();
});

test('an unlit glowtoy is not a visible object, as on the playfield and maps', () => {
  const crystal = new Roid({
    id: 'dark-crystal',
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
    material: 'crystal',
    ore: 'crystal',
    glowtoy: { charge: 0, cachePosition: { x: 0, y: 0 }, cacheRevealed: false },
  });
  bindAsteroidFieldApply({
    readBelt: () => [crystal],
    onCreated: () => undefined,
    onUpdated: () => undefined,
    onDestroyed: () => undefined,
    onReconciled: () => undefined,
  });
  const dark = objectMenuAt(pilot, 700, 300);
  expect(dark.target.kind).toBe('location');
  expect(dark.actions.map((item) => item.action)).not.toContain('inspect');
  crystal.glowtoy = { charge: 0.5, cachePosition: { x: 0, y: 0 }, cacheRevealed: false };
  expect(objectMenuAt(pilot, 700, 300).target.id).toBe('dark-crystal');
});
