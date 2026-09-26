import { afterEach, expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { controlSources, resetControlSources } from '../../../src/input/controlSources';
import { reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { Point } from '../../../src/physics/Point';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { projectWorldToScreenInto } from '../../../src/rendering/playfieldCamera';
import {
  rotatedViewSize,
  rotateVectorInto,
  travelCameraRotation,
} from '../../../src/rendering/travelCamera';
import { mapWorldToCanvas } from '../../../src/ui/universeMap';

const origin = { x: 0, y: 0 };
const viewport = { width: 1280, height: 900 };

afterEach(() => {
  canvasManager.destroy();
  resetControlSources();
});

test.each([
  { x: 4, y: 0 },
  { x: 0, y: 4 },
  { x: -4, y: 0 },
  { x: 0, y: -4 },
  { x: 3, y: 4 },
])('travel $x,$y points up even when the nose faces elsewhere', (velocity) => {
  const ship = { angle: 1.2, velocity };
  const rotation = travelCameraRotation(ship);
  const world = { x: velocity.x * 20, y: velocity.y * 20 };
  const point = projectWorldToScreenInto({ ...origin }, world, origin, viewport, 1, rotation);
  expect(point.x).toBeCloseTo(viewport.width / 2);
  expect(point.y).toBeLessThan(viewport.height / 2);
  const map = mapWorldToCanvas(world, origin, { x: 0, y: 0, size: 500, scale: 0.1 }, rotation);
  expect(map.x).toBeCloseTo(250);
  expect(map.y).toBeLessThan(250);
});

test('stopping for a map retains course and a new ship uses its spawn heading', () => {
  const ship = { angle: Math.PI / 2, velocity: { x: 4, y: 0 } };
  expect(travelCameraRotation(ship)).toBeCloseTo(-Math.PI / 2);
  ship.velocity = { ...origin };
  ship.angle = Math.PI;
  expect(travelCameraRotation(ship)).toBeCloseTo(-Math.PI / 2);
  expect(travelCameraRotation({ ...ship })).toBeCloseTo(Math.PI / 2);
});

test('screen picking inverts the rotated camera', () => {
  canvasManager.followTravel({ angle: 0, velocity: { x: 3, y: 4 } });
  const ship = { x: 420, y: -600 };
  const target = { x: -300, y: 117 };
  const screen = canvasManager.worldToScreen(target, ship);
  const world = canvasManager.screenToWorld(new Point(screen.x, screen.y), ship);
  expect(world.x).toBeCloseTo(target.x);
  expect(world.y).toBeCloseTo(target.y);
});

test('diagonal camera queries contain all four visible world corners', () => {
  const rotation = Math.PI / 3;
  const size = rotatedViewSize(viewport.width, viewport.height, rotation);
  for (const x of [-viewport.width / 2, viewport.width / 2]) {
    for (const y of [-viewport.height / 2, viewport.height / 2]) {
      const world = rotateVectorInto({ ...origin }, x, y, -rotation);
      expect(Math.abs(world.x)).toBeLessThanOrEqual(size.width / 2 + 1e-9);
      expect(Math.abs(world.y)).toBeLessThanOrEqual(size.height / 2 + 1e-9);
    }
  }
});

test('a held pointer keeps turning toward screen right after the course changes', () => {
  const player = new Player({
    id: 'gps-pilot',
    name: 'GPS',
    type: 'local',
    input: new MockPlayerInput(),
  });
  controlSources.pointerHeading = 0;
  for (const angle of [Math.PI / 2, 0, -Math.PI / 2, Math.PI]) {
    player.ship.angle = angle;
    player.ship.velocity = { x: Math.cos(angle) * 4, y: -Math.sin(angle) * 4 };
    canvasManager.followTravel(player.ship);
    reconcilePlayerInput(player);
    expect(player.ship.angularVelocity).toBeLessThan(0);
  }
  controlSources.pointerHeading = Math.PI / 2;
  reconcilePlayerInput(player);
  expect(player.ship.angularVelocity).toBeCloseTo(0);
});

test('a pipe ride follows each route turn and retains its arrival direction', () => {
  const player = new Player({
    id: 'pipe-pilot',
    name: 'Pipe',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.velocity = { x: 4, y: 0 };
  travelCameraRotation(player.ship);
  player.ship.velocity = { x: 0, y: 0 };
  player.ship.furnaceTransit = {
    sourceId: 'town-square',
    destinationId: 'street-1-0',
    startedAt: 0,
    durationMs: 1000,
  };
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    player.ship.angle = angle;
    expect(travelCameraRotation(player.ship)).toBeCloseTo(angle - Math.PI / 2);
  }
  player.ship.furnaceTransit = null;
  expect(travelCameraRotation(player.ship)).toBeCloseTo(-Math.PI);
});
