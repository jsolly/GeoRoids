import { afterEach, expect, test, vi } from 'vitest';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { RoidBelt } from '../../../src/entities/roid/Roid';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { NetworkManager } from '../../../src/network/networkManager';
import * as terrain from '../../../src/physics/terrain/terrainSession';
import { drawGame, scanCameraZoom } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { TestPath2D } from '../../support/TestPath2D';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};

afterEach(() => {
  canvasManager.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreViewport();
});

test('a failed terrain stroke during Scout scan restores flight coordinates and the next frame draws its HUD', () => {
  restoreViewport = setWindowViewport(800, 600, 2);
  vi.stubGlobal('Path2D', TestPath2D);
  vi.spyOn(terrain, 'getTerrainContours').mockReturnValue([
    {
      index: 0,
      height: 0,
      segments: [{ ax: -100, ay: 100, bx: 100, by: 100 }],
    },
  ]);
  const network = NetworkManager.getInstance();
  const players = PlayerManager.getInstance({
    networkPort: network,
    combatNetwork: network.combatNetwork,
  });
  const pilot = players.createLocalPlayer('scout');
  pilot.id = 'scanning-pilot';
  pilot.ship.position = { x: 0, y: 0 };
  pilot.ship.abilityActiveFrames = SHIP_ABILITY.SCAN_FRAMES;
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const ctx = canvasManager.requireContext();
  const viewport = canvasManager.getViewportSize();
  const target = scanCameraZoom(pilot.ship, viewport.width, viewport.height);
  canvasManager.easeZoomToward(target, 0);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(80);

  const readTransform = ctx.getTransform.bind(ctx);
  const transformQueries = vi.spyOn(ctx, 'getTransform');
  const styleQueries = vi.spyOn(window, 'getComputedStyle');
  const nativeSave = ctx.save.bind(ctx);
  const nativeRestore = ctx.restore.bind(ctx);
  let saveDepth = 0;
  vi.spyOn(ctx, 'save').mockImplementation(() => {
    nativeSave();
    saveDepth++;
  });
  vi.spyOn(ctx, 'restore').mockImplementation(() => {
    nativeRestore();
    saveDepth--;
  });
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'bevel';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#123456';
  ctx.shadowBlur = 7;
  const failure = new Error('Terrain stroke failed');
  const nativeStroke = ctx.stroke.bind(ctx);
  let failStroke = true;
  const contourTransforms: ReturnType<typeof readTransform>[] = [];
  const contourViewports: { width: number; height: number }[] = [];
  const contourDepths: number[] = [];
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    const path = args[0];
    if (!(path instanceof TestPath2D)) {
      Reflect.apply(nativeStroke, ctx, args);
      return;
    }
    contourTransforms.push(readTransform());
    contourViewports.push({ ...canvasManager.getViewportSize() });
    contourDepths.push(saveDepth);
    if (failStroke) {
      throw failure;
    }
    // The test recorder publishes the real painter's path to the native Canvas.
    ctx.beginPath();
    for (const command of path.commands) {
      ctx[command.kind](command.x, command.y);
    }
    nativeStroke();
  });
  const nativeFillText = ctx.fillText.bind(ctx);
  const hudTransforms: ReturnType<typeof readTransform>[] = [];
  vi.spyOn(ctx, 'fillText').mockImplementation((...args) => {
    if (args[0].startsWith('Bank ')) {
      hudTransforms.push(readTransform());
    }
    Reflect.apply(nativeFillText, ctx, args);
  });
  const draw = () => drawGame(pilot, new RoidBelt(), 123, 0, '', [pilot]);
  const baseTransform = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };

  expect(draw).toThrow(failure);
  expect(contourDepths).toEqual([3]);
  expect(contourViewports[0]?.height).toBeGreaterThan(600);
  expect(contourTransforms[0]?.a).toBeGreaterThan(target * 2);
  expect(contourTransforms[0]?.a).toBeLessThan(2);
  expect(canvasManager.getViewportSize()).toBe(viewport);
  expect(viewport).toEqual({ width: 800, height: 600 });
  expect(readTransform()).toMatchObject(baseTransform);
  expect(saveDepth).toBe(0);
  expect(ctx).toMatchObject({
    lineCap: 'butt',
    lineJoin: 'bevel',
    lineWidth: 3,
    strokeStyle: '#123456',
    shadowBlur: 7,
  });
  expect(hudTransforms).toEqual([]);
  expect(transformQueries).not.toHaveBeenCalled();
  expect(styleQueries).not.toHaveBeenCalled();

  failStroke = false;
  clock.mockReturnValue(96);
  expect(draw).not.toThrow();
  expect(contourTransforms).toHaveLength(2);
  expect(contourTransforms[1]?.a).toBeLessThan(contourTransforms[0]?.a ?? 0);
  expect(contourTransforms[1]?.a).toBeGreaterThan(target * 2);
  expect(hudTransforms).toHaveLength(1);
  expect(hudTransforms[0]).toMatchObject(baseTransform);
  expect(readTransform()).toMatchObject(baseTransform);
  expect(viewport).toEqual({ width: 800, height: 600 });
  expect(saveDepth).toBe(0);
  expect(styleQueries).not.toHaveBeenCalled();
});
