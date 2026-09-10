import { afterEach, expect, test, vi } from 'vitest';
import type { ShipKitId } from '../../../shared-types';
import { PALETTE, SHIELD, SHIP, VISUAL } from '../../../src/constants';
import { Laser } from '../../../src/entities/laser/Laser';
import { lootScreenRadius } from '../../../src/entities/loot/lootRenderer';
import { Player } from '../../../src/entities/player/Player';
import { advanceRemotePlayerShips } from '../../../src/entities/player/remoteLasers';
import {
  getKitHullOutline,
  projectHullPolyline,
  projectKitHullEdges,
} from '../../../src/entities/ship/hullOutlines';
import {
  drawLaserBolts,
  drawShipExplosion,
  drawShipShield,
  drawThruster,
  drawThrusterAtPosition,
  strokeKitHullOutline,
} from '../../../src/entities/ship/shipRenderer';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain, getTerrainField } from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvas';
import { drawContourLaserTicks } from '../../../src/rendering/contourLaserRenderer';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';
import { burstTick, driftSegment, easeOutCubic } from '../../../src/rendering/vectorJuice';
import { hexToRgba } from '../../../src/utils/colorUtils';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;

afterEach(() => {
  canvasManager.destroy();
  if (previousCanvas) {
    canvas?.replaceWith(previousCanvas);
  } else {
    canvas?.remove();
  }
  canvas = undefined;
  previousCanvas = null;
  vi.restoreAllMocks();
  restoreViewport();
});

function recordingContext() {
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.getElementById('gameCanvas');
  if (previousCanvas) {
    previousCanvas.replaceWith(canvas);
  } else {
    document.body.append(canvas);
  }
  restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  let points: Array<{ x: number; y: number }> = [];
  let arcs: Array<Parameters<CanvasRenderingContext2D['arc']>> = [];
  let closed = false;
  const strokes: Array<{
    points: typeof points;
    arcs: typeof arcs;
    closed: boolean;
    color: typeof ctx.strokeStyle;
    width: number;
    alpha: number;
    shadow: typeof ctx.shadowColor;
    blur: number;
  }> = [];
  const begin = ctx.beginPath.bind(ctx);
  const move = ctx.moveTo.bind(ctx);
  const line = ctx.lineTo.bind(ctx);
  const close = ctx.closePath.bind(ctx);
  const arc = ctx.arc.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    arcs = [];
    closed = false;
    begin();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push({ x, y });
    move(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push({ x, y });
    line(x, y);
  });
  vi.spyOn(ctx, 'closePath').mockImplementation(() => {
    closed = true;
    close();
  });
  vi.spyOn(ctx, 'arc').mockImplementation((...args) => {
    arcs.push(args);
    arc(...args);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({
      points: [...points],
      arcs: [...arcs],
      closed,
      color: ctx.strokeStyle,
      width: ctx.lineWidth,
      alpha: ctx.globalAlpha,
      shadow: ctx.shadowColor,
      blur: ctx.shadowBlur,
    });
    Reflect.apply(stroke, ctx, args);
  });
  const fill = vi.spyOn(ctx, 'fill');
  return { ctx, strokes, fill };
}

function canvasColor(ctx: CanvasRenderingContext2D, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  const normalized = ctx.strokeStyle;
  ctx.restore();
  return normalized;
}

function pilot(id: string, type: Player['type'] = 'local') {
  return new Player({ id, name: id, type, input: new MockPlayerInput() });
}

const KITS: ReadonlyArray<{ id: ShipKitId; vertices: number; aft: number }> = [
  { id: 'dart', vertices: 6, aft: -0.85 },
  { id: 'hauler', vertices: 7, aft: -0.85 },
  { id: 'warden', vertices: 6, aft: -0.575 },
  { id: 'skirmisher', vertices: 12, aft: -0.7 },
  { id: 'quake', vertices: 15, aft: -0.9125 },
];

test('every playable kit draws its outlined hull and retained details without filling', () => {
  const { ctx, strokes, fill } = recordingContext();
  for (const kit of KITS) {
    strokes.length = 0;
    strokeKitHullOutline(ctx, 100, 80, 24, 0.4, PALETTE.LOCAL, kit.id);
    const outline = getKitHullOutline(kit.id);
    expect(strokes.map((path) => path.points)).toEqual(
      [outline.hull, ...outline.extras].flatMap((line) => {
        const points = projectHullPolyline(100, 80, 24, 0.4, line);
        return [points, points];
      })
    );
    expect(strokes[0]?.points).toHaveLength(kit.vertices);
    expect(strokes.slice(0, 2).map((path) => path.closed)).toEqual([true, true]);
    expect(strokes.filter((_, index) => index % 2 === 1).map((path) => path.color)).toEqual(
      [outline.hull, ...outline.extras].map(() => canvasColor(ctx, PALETTE.LOCAL))
    );
  }
  expect(fill).not.toHaveBeenCalled();
});

test('shield impact renders a phosphor ring without filling the ship', () => {
  const player = pilot('visual-shield');
  player.ship.shieldActive = true;
  player.ship.shieldTime = 30;
  player.ship.shieldFlashTime = 4;
  const { ctx, strokes, fill } = recordingContext();
  drawShipShield(ctx, player.ship, 100, 80, 24);
  expect(strokes).toHaveLength(1);
  expect(strokes.flatMap((path) => path.arcs)).toHaveLength(1);
  expect(strokes[0]?.arcs[0]?.slice(0, 2)).toEqual([100, 80]);
  expect(strokes[0]?.color).toBe(canvasColor(ctx, hexToRgba(PALETTE.SHIELD, SHIELD.FLASH_ALPHA)));
  expect(fill).not.toHaveBeenCalled();
});

test('local and enemy shots draw short narrow trails, then the identified hit draws a ring and ticks', () => {
  const { ctx, strokes, fill } = recordingContext();
  const local = new Laser({ x: 30, y: 60 }, { x: 3, y: 4 }, 0, 0);
  local.serverId = 'local-diagonal';
  const enemy = new Laser({ x: -20, y: 80 }, { x: 0, y: -5 }, 0, 0);
  enemy.serverId = 'enemy-vertical';
  const viewer = { x: 10, y: 20 };
  ctx.save();
  const expectedBlur = [VISUAL.LASER_GLOW * 0.55, 0, VISUAL.LASER_GLOW, 0].map((blur) => {
    ctx.shadowBlur = blur;
    return ctx.shadowBlur;
  });
  ctx.restore();
  for (const { shot, color, trail, body } of [
    {
      shot: local,
      color: PALETTE.LASER_LOCAL,
      trail: [
        { x: 410.7, y: 327.6 },
        { x: 415.5, y: 334 },
      ],
      body: [
        { x: 415.5, y: 334 },
        { x: 424.5, y: 346 },
      ],
    },
    {
      shot: enemy,
      color: PALETTE.LASER_ENEMY,
      trail: [
        { x: 370, y: 375.5 },
        { x: 370, y: 367.5 },
      ],
      body: [
        { x: 370, y: 367.5 },
        { x: 370, y: 352.5 },
      ],
    },
  ]) {
    strokes.length = 0;
    drawLaserBolts([shot], color, viewer);
    expect(strokes.map((path) => path.points)).toEqual([trail, trail, body, body]);
    expect(strokes.map((path) => path.width)).toEqual([
      VISUAL.LASER_STROKE_WIDTH * 0.7,
      VISUAL.LASER_STROKE_WIDTH * 0.7,
      VISUAL.LASER_STROKE_WIDTH,
      VISUAL.LASER_STROKE_WIDTH,
    ]);
    expect(strokes.map((path) => path.color)).toEqual(
      [0.19, 0.38, 0.5, 1].map((alpha) => canvasColor(ctx, hexToRgba(color, alpha)))
    );
    expect(strokes.map((path) => path.blur)).toEqual(expectedBlur);
    expect(strokes.every((path) => path.shadow === canvasColor(ctx, color))).toBe(true);
    expect(strokes.every((path) => !path.closed && path.width <= 2.25 && path.alpha === 1)).toBe(
      true
    );
    expect(strokes.flatMap((path) => path.arcs)).toEqual([]);
  }
  expect(fill).not.toHaveBeenCalled();

  local.updateExplodeTime();
  strokes.length = 0;
  drawLaserBolts([local], PALETTE.LASER_LOCAL, viewer);
  expect(strokes).toHaveLength(5);
  expect(strokes[0]?.arcs[0]).toEqual([420, 340, 5.5, 0, Math.PI * 2, false]);
  expect(strokes.slice(1).map((path) => path.points.length)).toEqual([2, 2, 2, 2]);
  expect(strokes[1]?.points).toEqual([
    { x: 421.925, y: 340 },
    { x: 427.425, y: 340 },
  ]);
  expect(strokes.map((path) => path.width)).toEqual([1.25, 1, 1, 1, 1]);
  expect(strokes.every((path) => path.color === canvasColor(ctx, PALETTE.LASER_LOCAL))).toBe(true);
  expect(fill).not.toHaveBeenCalled();
});

test('local and remote kit thrusters draw two open V contours only while thrusting alive', () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const { ctx, strokes, fill } = recordingContext();
  const local = pilot('local-thrust');
  const remote = pilot('remote-thrust', 'remote');
  for (const kit of KITS) {
    for (const { player, center, color } of [
      { player: local, center: { x: 400, y: 300 }, color: PALETTE.LOCAL },
      { player: remote, center: { x: 490, y: 260 }, color: PALETTE.REMOTE },
    ]) {
      const ship = player.ship;
      ship.kitId = kit.id;
      ship.r = 20;
      ship.angle = 0;
      ship.position = { x: 100, y: -60 };
      ship.thrusting = true;
      ship.exploding = false;
      const draw = () =>
        player === local
          ? drawThruster(ship, color)
          : drawThrusterAtPosition(ship, { x: 10, y: -20 }, color);
      strokes.length = 0;
      draw();
      const rearX = center.x + 20 * kit.aft;
      const outer = [
        { x: rearX, y: center.y + 4 },
        { x: rearX - 13.6, y: center.y },
        { x: rearX, y: center.y - 4 },
      ];
      const inner = [
        { x: rearX, y: center.y + 2.2 },
        { x: rearX - 5.712, y: center.y },
        { x: rearX, y: center.y - 2.2 },
      ];
      expect(strokes.map((path) => path.points)).toEqual([outer, outer, inner, inner]);
      const outerTip = strokes[0]?.points[1];
      const innerTip = strokes[2]?.points[1];
      if (!outerTip || !innerTip) {
        throw new Error('Thrust did not draw both V tips');
      }
      const outerReach = rearX - outerTip.x;
      const innerReach = rearX - innerTip.x;
      expect(innerReach).toBeLessThan(outerReach);
      expect(innerReach / outerReach).toBeCloseTo(VISUAL.THRUSTER_CORE_RATIO);
      expect(strokes.map((path) => path.width)).toEqual([1.25, 1.25, 0.9375, 0.9375]);
      expect(strokes.map((path) => path.color)).toEqual(
        [0.4, 1, 0.28, 0.7].map((alpha) => canvasColor(ctx, hexToRgba(color, alpha)))
      );
      expect(strokes.every((path) => !path.closed && path.arcs.length === 0)).toBe(true);
      ship.thrusting = false;
      strokes.length = 0;
      draw();
      expect(strokes).toEqual([]);
      ship.thrusting = true;
      ship.exploding = true;
      draw();
      expect(strokes).toEqual([]);
    }
  }
  expect(fill).not.toHaveBeenCalled();
});

test('a destroyed dart breaks into drifting hull edges, an expanding ring and unfilled sparks', () => {
  const { ctx, strokes, fill } = recordingContext();
  const ship = pilot('destroyed-dart').ship;
  ship.kitId = 'dart';
  ship.r = 20;
  ship.angle = 0;
  ship.exploding = true;
  ship.explodeTime = SHIP.EXPLODE_DURATION_FRAMES / 2;
  drawShipExplosion(ship, PALETTE.LOCAL);

  expect(VISUAL.EXPLOSION_SPARKS).toBeGreaterThanOrEqual(8);
  expect(VISUAL.EXPLOSION_HIT_TICKS).toBe(4);
  expect(VISUAL.EXPLOSION_RING_RATIO).toBeGreaterThan(1.5);
  expect(easeOutCubic(0)).toBe(0);
  expect(easeOutCubic(1)).toBe(1);
  expect(easeOutCubic(0.5)).toBe(0.875);
  expect(burstTick(0, 0, 0, 4, 10)).toEqual({ x1: 4, y1: 0, x2: 10, y2: 0 });
  expect(strokes).toHaveLength(1 + 6 + VISUAL.EXPLOSION_SPARKS + 4);
  expect(strokes[0]?.arcs[0]).toEqual([400, 300, 52.125, 0, Math.PI * 2]);
  const edges = projectKitHullEdges(400, 300, 20, 0, 'dart');
  expect(edges).toHaveLength(6);
  expect(strokes.slice(1, 7).map((path) => path.points)).toEqual(
    edges.map(([a, b]) => {
      const edge = driftSegment(a, b, { x: 400, y: 300 }, 0.5, 41, 0.7);
      return [edge.a, edge.b];
    })
  );
  const firstEdge = strokes[1]?.points;
  const edgeA = firstEdge?.[0];
  const edgeB = firstEdge?.[1];
  if (!edgeA || !edgeB) {
    throw new Error('Destroyed dart did not draw its first drifting hull edge');
  }
  expect(
    Math.hypot((edgeA.x + edgeB.x) / 2 - 402.125, (edgeA.y + edgeB.y) / 2 - 298.375)
  ).toBeCloseTo(35.875);
  const sparks = strokes.slice(7, 7 + VISUAL.EXPLOSION_SPARKS);
  const ticks = strokes.slice(7 + VISUAL.EXPLOSION_SPARKS);
  expect(sparks.every((path) => path.points.length === 2)).toBe(true);
  const sparkInner = sparks[0]?.points[0];
  const sparkOuter = sparks[0]?.points[1];
  if (!sparkInner || !sparkOuter) {
    throw new Error('Destroyed dart did not draw a complete spark');
  }
  expect(Math.hypot(sparkInner.x - 400, sparkInner.y - 300)).toBeCloseTo(27.125);
  expect(Math.hypot(sparkOuter.x - 400, sparkOuter.y - 300)).toBeCloseTo(36.125);
  expect(ticks[0]?.points).toEqual([
    { x: 411, y: 300 },
    { x: 441.25, y: 300 },
  ]);
  expect(strokes[0]?.color).toBe(canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575 * 0.85)));
  expect(
    strokes
      .slice(1, 7 + VISUAL.EXPLOSION_SPARKS)
      .every((path) => path.color === canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575)))
  ).toBe(true);
  expect(
    ticks.every((path) => path.color === canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575 * 0.75)))
  ).toBe(true);
  expect(fill).not.toHaveBeenCalled();
});

test('remote ship lifecycle advances on the shared update clock', () => {
  const remote = pilot('remote-visual', 'remote');
  const updateLifecycle = vi.spyOn(remote.ship, 'updateLifecycle');
  advanceRemotePlayerShips([remote]);
  expect(updateLifecycle).toHaveBeenCalledOnce();
});

test('terrain and contour laser renderers emit finite muted strokes at runtime', () => {
  const { ctx, strokes } = recordingContext();
  const prior = getTerrainField();
  try {
    ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 3100 });
    drawIsoContours({ x: 1000, y: 0 });
    expect(strokes.some((path) => path.points.length > 0)).toBe(true);
    expect(
      strokes
        .flatMap((path) => path.points)
        .every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
    ).toBe(true);
    expect(
      strokes.every((path) =>
        [VISUAL.CONTOUR_ALPHA, VISUAL.CONTOUR_INDEX_ALPHA].some(
          (alpha) => path.color === canvasColor(ctx, hexToRgba(PALETTE.CONTOUR, alpha))
        )
      )
    ).toBe(true);
    strokes.length = 0;
    drawContourLaserTicks({ x: 1000, y: 0 }, [{ x: 1100, y: 0 }]);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.points).toHaveLength(2);
    expect(strokes[0]?.color).toBe(
      canvasColor(ctx, hexToRgba(PALETTE.LOOT, VISUAL.CONTOUR_LASER_ALPHA))
    );
    expect(
      strokes
        .flatMap((path) => path.points)
        .every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
    ).toBe(true);
    expect(VISUAL.CONTOUR_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.SHIP_STROKE_WIDTH);
    expect(VISUAL.CONTOUR_LASER_STROKE_WIDTH).toBeLessThanOrEqual(VISUAL.LASER_STROKE_WIDTH);
    expect(lootScreenRadius(20, 1)).toBeGreaterThan(0);
    expect(lootScreenRadius(Number.POSITIVE_INFINITY, 1)).toBeNull();
  } finally {
    ensureTerrain(prior.seed, { cx: prior.cx, cy: prior.cy, radius: prior.radius });
  }
});

test('touch input targets the game canvas while the title terrain stays passive', async () => {
  vi.resetModules();
  const { InputManager } = await import('../../../src/core/services/InputManager');
  const listeners: Array<() => void> = [];
  const add = window.EventTarget.prototype.addEventListener;
  vi.spyOn(window.EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options
  ) {
    add.call(this, type, listener, options);
    listeners.push(() => this.removeEventListener(type, listener, options));
  });
  const touchControls = document.getElementById('touch-controls');
  const oldTouchContent = touchControls?.innerHTML;
  const bodyClass = document.body.className;
  try {
    InputManager.getInstance().initializeListeners();
    const gameCanvas = document.getElementById('gameCanvas');
    const titleTerrain = document.getElementById('title-terrain');
    if (!gameCanvas || !titleTerrain) {
      throw new Error('expected both canvases in the play shell');
    }
    expect(gameCanvas.tagName).toBe('CANVAS');
    expect(titleTerrain.tagName).toBe('CANVAS');
    const gameTouch = new Event('touchstart', { cancelable: true });
    const titleTouch = new Event('touchstart', { cancelable: true });
    gameCanvas.dispatchEvent(gameTouch);
    titleTerrain.dispatchEvent(titleTouch);
    expect(gameTouch.defaultPrevented).toBe(true);
    expect(titleTouch.defaultPrevented).toBe(false);
  } finally {
    for (const remove of listeners) {
      remove();
    }
    if (touchControls && oldTouchContent !== undefined) {
      touchControls.innerHTML = oldTouchContent;
    }
    document.body.className = bodyClass;
    vi.resetModules();
  }
});
