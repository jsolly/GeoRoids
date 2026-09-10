import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE, VISUAL } from '../../../src/constants';
import { InputManager } from '../../../src/core/services/InputManager';
import { lootScreenRadius } from '../../../src/entities/loot/lootRenderer';
import { Player } from '../../../src/entities/player/Player';
import { advanceRemotePlayerShips } from '../../../src/entities/player/remoteLasers';
import {
  drawShipShield,
  strokeKitHullOutline,
  strokePhosphorSegment,
} from '../../../src/entities/ship/shipRenderer';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { Point } from '../../../src/physics/Point';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain } from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvas';
import { drawContourLaserTicks } from '../../../src/rendering/contourLaserRenderer';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';

type RecordingContext = CanvasRenderingContext2D & {
  operations: string[];
  strokes: number;
  arcs: number;
  fills: number;
};

function recordingContext(): RecordingContext {
  const operations: string[] = [];
  let ctx = {} as RecordingContext;
  ctx = {
    operations,
    strokes: 0,
    arcs: 0,
    fills: 0,
    save: () => operations.push('save'),
    restore: () => operations.push('restore'),
    beginPath: () => operations.push('beginPath'),
    closePath: () => operations.push('closePath'),
    moveTo: () => operations.push('moveTo'),
    lineTo: () => operations.push('lineTo'),
    arc: () => {
      operations.push('arc');
      ctx.arcs += 1;
    },
    stroke: () => {
      operations.push('stroke');
      ctx.strokes += 1;
    },
    fill: () => {
      operations.push('fill');
      ctx.fills += 1;
    },
    setLineDash: () => undefined,
  } as unknown as RecordingContext;
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('every playable ship kit renders through the phosphor hull renderer', () => {
  const ctx = recordingContext();
  for (const kitId of ['dart', 'hauler', 'warden', 'skirmisher', 'quake'] as const) {
    strokeKitHullOutline(ctx, 100, 80, 24, 0.4, PALETTE.LOCAL, kitId);
  }

  expect(ctx.strokes).toBeGreaterThan(10);
  expect(ctx.operations).toContain('closePath');
  expect(ctx.fills).toBe(0);
});

test('shield impact renders as a phosphor ring and never fills the ship', () => {
  const player = new Player({
    id: 'visual-shield',
    name: 'Visual Shield',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.shieldActive = true;
  player.ship.shieldTime = 30;
  player.ship.shieldFlashTime = 4;
  const ctx = recordingContext();

  drawShipShield(ctx, player.ship, 100, 80, 24);

  expect(ctx.arcs).toBe(1);
  expect(ctx.strokes).toBe(1);
  expect(ctx.fills).toBe(0);
});

test('live ship and laser strokes use the configured phosphor palette', () => {
  const ctx = recordingContext();
  strokePhosphorSegment(ctx, 10, 20, 50, 60, PALETTE.LASER_LOCAL, VISUAL.LASER_STROKE_WIDTH, 0);

  expect(ctx.strokes).toBe(2);
  expect(PALETTE.LOCAL.toLowerCase()).not.toBe('#ffffff');
  expect(PALETTE.REMOTE.toLowerCase()).not.toBe('#ffffff');
  expect(PALETTE.BOT.toLowerCase()).not.toBe('#ffffff');
  expect(PALETTE.LASER_LOCAL).toBe('#FDE68A');
  expect(PALETTE.LASER_ENEMY.toLowerCase()).not.toBe('#ffffff');
});

test('remote ship lifecycle advances on the shared update clock', () => {
  const remote = new Player({
    id: 'remote-visual',
    name: 'Remote Visual',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  const updateLifecycle = vi.spyOn(remote.ship, 'updateLifecycle');

  advanceRemotePlayerShips([remote], 3);

  expect(updateLifecycle).toHaveBeenCalledWith(3);
});

test('terrain and contour laser renderers emit finite muted strokes at runtime', () => {
  const ctx = recordingContext();
  const canvas = { width: 800, height: 600 } as HTMLCanvasElement;
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'worldToScreen').mockImplementation(
    (world) => new Point(world.x + 400, world.y + 300)
  );
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, world) => {
    out.x = world.x + 400;
    out.y = world.y + 300;
    return out;
  });
  ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 3100 });

  drawIsoContours({ x: 0, y: 0 });
  drawContourLaserTicks({ x: 0, y: 0 }, [{ x: 1100, y: 0 }]);

  expect(ctx.strokes).toBeGreaterThan(0);
  expect(PALETTE.CONTOUR).toBe('#5A6B7D');
  expect(PALETTE.LOOT).toBe('#E8D5A3');
  expect(VISUAL.CONTOUR_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.SHIP_STROKE_WIDTH);
  expect(VISUAL.CONTOUR_LASER_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.LASER_STROKE_WIDTH);
  expect(lootScreenRadius(20, 1)).toBeGreaterThan(0);
  expect(lootScreenRadius(Number.POSITIVE_INFINITY, 1)).toBeNull();
});

test('mouse input is attached to the game canvas while the title terrain stays passive', () => {
  InputManager.getInstance().initializeListeners();
  const gameCanvas = document.getElementById('gameCanvas');
  const titleTerrain = document.getElementById('title-terrain');
  expect(gameCanvas?.tagName).toBe('CANVAS');
  expect(titleTerrain?.tagName).toBe('CANVAS');
  if (!gameCanvas || !titleTerrain) {
    throw new Error('expected both canvases in the play shell');
  }

  const gameTouch = new Event('touchstart', { cancelable: true });
  const titleTouch = new Event('touchstart', { cancelable: true });
  gameCanvas.dispatchEvent(gameTouch);
  titleTerrain.dispatchEvent(titleTouch);

  expect(gameTouch.defaultPrevented).toBe(true);
  expect(titleTouch.defaultPrevented).toBe(false);
});
