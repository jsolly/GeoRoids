import { afterEach, expect, test, vi } from 'vitest';
import { CONTOUR_LOCK } from '../../../shared/contourLock';
import { sampleGradient } from '../../../shared/heightfield';
import { SHIP_ABILITY } from '../../../shared/shipKits';
import { TERRAIN } from '../../../shared/terrainConfig';
import { ensureTerrain, getTerrainField } from '../../../shared/terrainField';
import { WORLD } from '../../../shared/world';
import type { ContourBridge } from '../../../shared-types';
import { PALETTE } from '../../../src/constants';
import { createPlayer } from '../../../src/entities/player/createPlayer';
import { RoidBelt } from '../../../src/entities/roid/Roid';
import { setContourBridges } from '../../../src/physics/terrain/contourBridgeSession';
import { findContourCapture, findContourHop } from '../../../src/physics/terrain/contourCapture';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import * as contours from '../../../src/physics/terrain/contours';
import {
  builtContourPatchCount,
  getTerrainContours,
  stopTerrainPrefetch,
} from '../../../src/physics/terrain/terrainSession';
import { drawGame } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { simpleScanNavigation } from '../../../src/rendering/simpleScanNavigation';
import { TestPath2D, type TestPathCommand } from '../../support/TestPath2D';
import { setWindowViewport } from '../../support/viewport';

const originalLocation = window.location.href;
const originalTerrain = getTerrainField();
let restoreViewport = () => {};

afterEach(() => {
  canvasManager.destroy();
  setContourBridges();
  stopTerrainPrefetch();
  ensureTerrain(originalTerrain.seed, originalTerrain);
  window.history.replaceState(null, '', originalLocation);
  restoreViewport();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function segmentDistanceSquared(segment: ContourLevel['segments'][number], x: number, y: number) {
  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - segment.ax) * dx + (y - segment.ay) * dy) / length));
  return (x - segment.ax - t * dx) ** 2 + (y - segment.ay - t * dy) ** 2;
}

test('zoomed Scan retains every exact local capture and hop line without building a wide detailed patch', () => {
  vi.useFakeTimers();
  restoreViewport = setWindowViewport(800, 1094, 1.5);
  window.history.replaceState(null, '', '/?performance=collect&scanDetail=simple');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  canvasManager.easeZoomToward(0.25, 0);
  ensureTerrain(916, { cx: 0, cy: 0, radius: 100_000 });
  const center = { x: 1000, y: 1000 };
  const levels = getTerrainContours(center, 800);
  const target = levels
    .flatMap((level) => level.segments)
    .find(
      (segment) =>
        Math.hypot(
          (segment.ax + segment.bx) / 2 - center.x,
          (segment.ay + segment.by) / 2 - center.y
        ) < 600
    );
  if (!target) {
    throw new Error('Expected a known local line in the fixed terrain seed');
  }
  const position = { x: (target.ax + target.bx) / 2, y: (target.ay + target.by) / 2 };
  const capture = findContourCapture(position, 0);
  expect(capture).not.toBeNull();
  const marches = vi.spyOn(contours, 'extractIsoContours');
  const source = getTerrainContours(position, 800);
  const sourceSegments = source.flatMap((level) => level.segments);
  const hopLines = sourceSegments.filter(
    (segment) =>
      segmentDistanceSquared(segment, position.x, position.y) <= CONTOUR_LOCK.hopRadius ** 2
  );
  const distant = sourceSegments.find(
    (segment) => segmentDistanceSquared(segment, position.x, position.y) > 1_000_000
  );
  expect(hopLines.length).toBeGreaterThan(0);
  expect(distant).toBeDefined();

  let first: ReturnType<typeof simpleScanNavigation> | undefined;
  for (const now of [0, 16, 100, 400, 800]) {
    canvasManager.easeZoomToward(0.25, now);
    const lines = simpleScanNavigation(
      position,
      canvasManager.getViewportSize(),
      canvasManager.getPlayfieldScale()
    );
    const retained = lines.flatMap((level) => level.segments);
    expect(retained).toContain(target);
    for (const required of hopLines) {
      expect(retained).toContain(required);
    }
    expect(retained).not.toContain(distant);
    expect(retained.length).toBeLessThan(sourceSegments.length / 4);
    expect(findContourCapture(position, 0)).toEqual(capture);
    if (first) {
      for (const [index, line] of lines.entries()) {
        expect(line.segments).toBe(first[index]?.segments);
      }
    }
    first = lines;
  }
  vi.runAllTimers();
  expect(builtContourPatchCount()).toBe(1);
  expect(marches).not.toHaveBeenCalled();
  expect(canvasManager.getViewportSize()).toEqual({ width: 800, height: 1094 });
});

test('an active rail and charged bridge remain drawn while full and simple Scan agree on capture and both hop directions', () => {
  restoreViewport = setWindowViewport(800, 1094, 1.5);
  ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: WORLD.radius });
  vi.stubGlobal('Path2D', TestPath2D);
  window.history.replaceState(null, '', '/?performance=collect&scanDetail=full');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const ctx = canvasManager.requireContext();
  const pilot = createPlayer({
    id: 'charged-bridge-pilot',
    name: 'Pilot',
    type: 'local',
    kitId: 'scout',
    position: { x: 2253.9780217479483, y: -0.007169463344477992 },
  });
  pilot.ship.contourLock = { height: 0.16, direction: 1 };
  pilot.ship.abilityActiveFrames = SHIP_ABILITY.SCAN_FRAMES;
  const bridge: ContourBridge = {
    id: 'charged-local-bridge',
    ownerId: pilot.id,
    from: { ...pilot.ship.position },
    to: { x: pilot.ship.position.x - 60, y: pilot.ship.position.y },
    source: { height: 0.16, direction: 1 },
    target: { height: 0.08, direction: 1 },
    charged: true,
    framesLeft: 180,
  };
  setContourBridges([bridge]);
  const gradient = sampleGradient(getTerrainField(), pilot.ship.position.x, pilot.ship.position.y);
  const backward = { x: gradient.y, y: -gradient.x };
  const before = {
    capture: findContourCapture(pilot.ship.position, pilot.ship.angle),
    hop: findContourHop(pilot.ship.position, pilot.ship.contourLock, { x: -1, y: 0 }),
    reverse: findContourHop(pilot.ship.position, pilot.ship.contourLock, backward),
  };
  expect(before.capture).toEqual({ height: 0.16, direction: -1 });
  expect(before.hop).toEqual({ height: 0.08, direction: 1 });
  expect(before.reverse).toEqual({ height: 0.16, direction: -1 });

  type Stroke = {
    origin: 'native';
    path: TestPath2D | null;
    commands: readonly TestPathCommand[];
    ink: string | CanvasGradient | CanvasPattern;
    alpha: number;
    width: number;
    transform: DOMMatrix;
  };
  const strokes: Stroke[] = [];
  const labels: Array<{
    origin: Stroke['origin'];
    text: string;
    x: number;
    y: number;
    ink: string | CanvasGradient | CanvasPattern;
  }> = [];
  function record(context: CanvasRenderingContext2D, origin: Stroke['origin']) {
    let commands: TestPathCommand[] = [];
    const nativeBegin = context.beginPath.bind(context);
    const nativeMove = context.moveTo.bind(context);
    const nativeLine = context.lineTo.bind(context);
    const nativeStroke = context.stroke.bind(context);
    const nativeText = context.fillText.bind(context);
    vi.spyOn(context, 'beginPath').mockImplementation(() => {
      commands = [];
      nativeBegin();
    });
    vi.spyOn(context, 'moveTo').mockImplementation((x, y) => {
      commands.push({ kind: 'moveTo', x, y });
      nativeMove(x, y);
    });
    vi.spyOn(context, 'lineTo').mockImplementation((x, y) => {
      commands.push({ kind: 'lineTo', x, y });
      nativeLine(x, y);
    });
    vi.spyOn(context, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
      const path = args[0] instanceof TestPath2D ? args[0] : null;
      strokes.push({
        origin,
        path,
        commands: path?.commands ?? [...commands],
        ink: context.strokeStyle,
        alpha: context.globalAlpha,
        width: context.lineWidth,
        transform: context.getTransform(),
      });
      if (!path) {
        Reflect.apply(nativeStroke, context, args);
        return;
      }
      nativeBegin();
      for (const command of path.commands) {
        if (command.kind === 'moveTo') {
          nativeMove(command.x, command.y);
        } else {
          nativeLine(command.x, command.y);
        }
      }
      nativeStroke();
    });
    vi.spyOn(context, 'fillText').mockImplementation((...args) => {
      labels.push({ origin, text: args[0], x: args[1], y: args[2], ink: context.fillStyle });
      Reflect.apply(nativeText, context, args);
    });
  }
  record(ctx, 'native');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const belt = new RoidBelt();
  drawGame(pilot, belt, [pilot]);
  clock.mockReturnValue(400);
  drawGame(pilot, belt, [pilot]);
  const fullTrack = strokes.findLast(
    (stroke) =>
      stroke.path !== null && stroke.ink === PALETTE.LOCAL.toLowerCase() && stroke.alpha === 0.5
  );
  if (!fullTrack) {
    throw new Error('Expected the full route to draw its active exact contour track');
  }
  expect(fullTrack.commands.length).toBeGreaterThan(20);
  expect(fullTrack.width).toBe(1.5);
  expect(
    labels.some(
      (label) => label.origin === 'native' && label.text === '3 · DRAFT' && label.ink === '#a4eeff'
    )
  ).toBe(true);
  expect(findContourCapture(pilot.ship.position, pilot.ship.angle)).toEqual(before.capture);
  expect(findContourHop(pilot.ship.position, pilot.ship.contourLock, { x: -1, y: 0 })).toEqual(
    before.hop
  );
  expect(findContourHop(pilot.ship.position, pilot.ship.contourLock, backward)).toEqual(
    before.reverse
  );

  canvasManager.destroy();
  window.history.replaceState(null, '', '/?performance=collect&scanDetail=simple');
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(canvasManager.requireContext()).toBe(ctx);
  strokes.length = 0;
  labels.length = 0;
  clock.mockReturnValue(0);
  drawGame(pilot, belt, [pilot]);
  clock.mockReturnValue(400);
  drawGame(pilot, belt, [pilot]);
  const simpleTrack = strokes.findLast(
    (stroke) =>
      stroke.origin === 'native' &&
      stroke.path !== null &&
      stroke.ink === PALETTE.LOCAL.toLowerCase() &&
      stroke.alpha === 0.5
  );
  expect(simpleTrack?.path).toBe(fullTrack.path);
  expect(simpleTrack?.commands).toEqual(fullTrack.commands);
  expect(simpleTrack?.width).toBe(1.5);
  expect(simpleTrack?.transform.a).toBeLessThan(1.5);
  expect(
    labels.some(
      (label) =>
        label.origin === 'native' &&
        label.text === '3 · DRAFT' &&
        label.x === 400 &&
        label.y === 538 &&
        label.ink === '#a4eeff'
    )
  ).toBe(true);
  expect(
    strokes.some(
      (stroke) =>
        stroke.origin === 'native' &&
        stroke.ink === '#a4eeff' &&
        stroke.width === 2 &&
        stroke.commands[0]?.kind === 'moveTo' &&
        stroke.commands[0].x === 400 &&
        stroke.commands[0].y === 547 &&
        stroke.commands[1]?.kind === 'lineTo' &&
        stroke.commands[1].x < 400 &&
        stroke.commands[1].y === 547
    )
  ).toBe(true);
  expect(pilot.ship.contourLock).toEqual({ height: 0.16, direction: 1 });
  expect(findContourCapture(pilot.ship.position, pilot.ship.angle)).toEqual(before.capture);
  expect(findContourHop(pilot.ship.position, pilot.ship.contourLock, { x: -1, y: 0 })).toEqual(
    before.hop
  );
  expect(findContourHop(pilot.ship.position, pilot.ship.contourLock, backward)).toEqual(
    before.reverse
  );
  expect(canvasManager.getViewportSize()).toEqual({ width: 800, height: 1094 });
});
