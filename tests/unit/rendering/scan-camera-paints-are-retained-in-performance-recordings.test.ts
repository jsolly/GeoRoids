import { afterEach, expect, test, vi } from 'vitest';
import { clientPerformance } from '../../../src/diagnostics/performanceMetrics';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { RoidBelt } from '../../../src/entities/roid/Roid';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import * as terrain from '../../../src/physics/terrain/terrainSession';
import { drawGame } from '../../../src/rendering/canvas';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setWindowViewport } from '../../support/viewport';

// Replace only the URL-selected singleton at the module boundary. The real
// recorder and production camera/cache methods execute without observation spies.
vi.mock('../../../src/diagnostics/performanceMetrics', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/diagnostics/performanceMetrics')>();
  return { ...actual, clientPerformance: new actual.ClientPerformanceMetrics(true) };
});

let restoreViewport = () => {};
const originalUrl = window.location.href;
afterEach(() => {
  canvasManager.destroy();
  clientPerformance.setPhase('menu');
  clientPerformance.read(true);
  vi.restoreAllMocks();
  restoreViewport();
  window.history.replaceState({}, '', originalUrl);
});

function currentZoom(): number {
  const ctx = canvasManager.requireContext();
  canvasManager.beginWorldLayers(ctx);
  const zoom = ctx.getTransform().a / 1.5;
  canvasManager.endWorldLayers(ctx);
  return zoom;
}

test('production scan camera and cache outcomes reach enabled recording drains and interval witnesses', () => {
  restoreViewport = setWindowViewport(800, 1094, 1.5);
  window.history.replaceState({}, '', '?performance=collect&scanScenery=cache');
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  vi.spyOn(terrain, 'getTerrainContours').mockReturnValue([]);
  vi.spyOn(terrain, 'peekBuiltContourRegion').mockReturnValue({
    levels: [],
    bounds: { cx: 0, cy: 0, radius: 100_000, gridSize: 96 },
  });
  const network = ConnectionManager.getInstance();
  const players = PlayerManager.getInstance({
    networkPort: network,
    combatNetwork: network.combatNetwork,
  });
  const pilot = players.createLocalPlayer('scout');
  pilot.id = 'recorded-cache-pilot';
  pilot.ship.position = { x: 0, y: 0 };
  pilot.ship.abilityActiveFrames = 120;
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  clientPerformance.setPhase('play');
  clientPerformance.read(true);
  const belt = new RoidBelt();
  const paint = () => drawGame(pilot, belt, [pilot]);

  paint();
  clientPerformance.recordFrameWork(1, 2, 3);
  clientPerformance.recordFrameInterval(30, 30);
  // Camera timestamp, cache build start, cache build end, then live foreground.
  now
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(101)
    .mockReturnValueOnce(103)
    .mockReturnValue(105);
  paint();
  const enteringZoom = currentZoom();
  expect(enteringZoom).toBeGreaterThan(800 / 2760);
  expect(enteringZoom).toBeLessThan(1);
  clientPerformance.recordFrameWork(1, 8, 9);
  clientPerformance.recordFrameInterval(40, 70);

  // Same numeric zoom and timestamp; changing the real scan target changes the
  // production camera stage to return, rather than inferring stage from zoom.
  pilot.ship.abilityActiveFrames = 0;
  now.mockReturnValue(100);
  paint();
  expect(currentZoom()).toBe(enteringZoom);
  clientPerformance.recordFrameWork(2, 4, 6);
  const first = clientPerformance.read(true);
  expect(first.counters).toMatchObject({
    scanSceneryMisses: 1,
    scanSceneryBuilds: 1,
    scanSceneryHits: 1,
  });
  expect(first.metrics['play.scanSceneryBuildMs']?.values).toEqual([2]);
  expect(first.metrics['play.scanEnterFrameIntervalMs']).toMatchObject({ count: 2, sum: 70 });
  expect(first.slowFrames.values).toMatchObject([
    {
      intervalMs: 40,
      previousFrame: { stage: 'enter', scenery: { kind: 'built', cause: 'cold' } },
    },
    { intervalMs: 30, previousFrame: { stage: 'enter', scenery: { kind: 'native' } } },
  ]);

  // A destructive collection drain preserves the last completed render context.
  clientPerformance.recordFrameInterval(50, 120);
  pilot.ship.position = { x: 100, y: 0 };
  now
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(101)
    .mockReturnValueOnce(104)
    .mockReturnValue(105);
  paint();
  clientPerformance.recordFrameWork(2, 10, 12);
  clientPerformance.recordFrameInterval(60, 180);
  pilot.ship.position = { x: 10_000, y: -20_000 };
  vi.mocked(terrain.peekBuiltContourRegion).mockReturnValue(undefined);
  now.mockReturnValue(100);
  paint();
  clientPerformance.recordFrameWork(1, 7, 8);
  clientPerformance.recordFrameInterval(70, 250);
  const second = clientPerformance.read(true);
  expect(second.counters).toMatchObject({
    scanSceneryMisses: 2,
    scanSceneryBuilds: 1,
    scanSceneryFallbacks: 1,
  });
  expect(second.metrics['play.scanSceneryBuildMs']?.values).toEqual([3]);
  expect(second.metrics['play.scanReturnFrameIntervalMs']).toMatchObject({ count: 3, sum: 180 });
  expect(second.metrics['play.scanFrameIntervalMs']).toMatchObject({ count: 3, sum: 180 });
  expect(second.slowFrames.values).toMatchObject([
    {
      intervalMs: 70,
      previousFrame: { stage: 'return', scenery: { kind: 'fallback', reason: 'source' } },
    },
    {
      intervalMs: 60,
      previousFrame: { stage: 'return', scenery: { kind: 'built', cause: 'pan' } },
    },
    { intervalMs: 50, previousFrame: { stage: 'return', scenery: { kind: 'cached' } } },
  ]);
  expect(clientPerformance.read().metrics).toEqual({});
});
