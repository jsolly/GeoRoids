import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import {
  chooseObjectAction,
  objectMenuAt,
  tickObjectApproach,
  worldPoint,
} from '../../../src/input/objectActions';
import { resetWorldExploration, setWorldMapAssets } from '../../../src/network/worldExploration';
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
