import { afterEach, expect, test, vi } from 'vitest';
import type { ShipKitId } from '../../../shared-types';
import { PALETTE, SHIP, VISUAL } from '../../../src/constants';
import { Laser } from '../../../src/entities/laser/Laser';
import { lootScreenRadius } from '../../../src/entities/loot/lootRenderer';
import { Player } from '../../../src/entities/player/Player';
import { advanceRemotePlayerShips } from '../../../src/entities/player/remoteLasers';
import {
  getHaulerEquipment,
  getKitHullOutline,
  projectHullPolyline,
  projectKitHullEdges,
} from '../../../src/entities/ship/hullOutlines';
import {
  drawLaserBolts,
  drawShipExplosion,
  drawThruster,
  drawThrusterAtPosition,
  strokeKitHullOutline,
} from '../../../src/entities/ship/shipRenderer';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { TERRAIN } from '../../../src/physics/terrain/terrainConfig';
import { ensureTerrain, getTerrainField } from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawContourLaserTicks } from '../../../src/rendering/contourLaserRenderer';
import { drawIsoContours } from '../../../src/rendering/contourRenderer';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { burstTick, driftSegment, easeOutCubic } from '../../../src/rendering/vectorJuice';
import { hexToRgba } from '../../../src/utils/colorUtils';
import { TestPath2D } from '../../support/TestPath2D';
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
  vi.unstubAllGlobals();
  restoreViewport();
});

function recordingContext() {
  canvasManager.destroy();
  canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  previousCanvas = document.querySelector('#gameCanvas');
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
  let commands: Array<'move' | 'line'> = [];
  const strokes: Array<{
    points: typeof points;
    arcs: typeof arcs;
    closed: boolean;
    commands: typeof commands;
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
    commands = [];
    arcs = [];
    closed = false;
    begin();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    commands.push('move');
    points.push({ x, y });
    move(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    commands.push('line');
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
    const path = args[0];
    const strokePoints =
      path instanceof TestPath2D ? path.commands.map(({ x, y }) => ({ x, y })) : points;
    strokes.push({
      points: [...strokePoints],
      arcs: [...arcs],
      closed,
      commands: [...commands],
      color: ctx.strokeStyle,
      width: ctx.lineWidth,
      alpha: ctx.globalAlpha,
      shadow: ctx.shadowColor,
      blur: ctx.shadowBlur,
    });
    if (!(path instanceof TestPath2D)) {
      Reflect.apply(stroke, ctx, args);
    }
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

const KITS: ReadonlyArray<{ id: ShipKitId }> = [{ id: 'scout' }, { id: 'hauler' }];

test('every playable kit draws its outlined hull and retained details without filling', () => {
  const { ctx, strokes, fill } = recordingContext();
  for (const kit of KITS) {
    strokes.length = 0;
    strokeKitHullOutline(ctx, 100, 80, 24, 0.4, PALETTE.LOCAL, kit.id);
    const outline = getKitHullOutline(kit.id);
    const lines = [
      outline.hull,
      ...outline.extras,
      ...(kit.id === 'hauler' ? getHaulerEquipment('tow_cable') : []),
    ];
    expect(strokes.map((path) => path.points)).toEqual(
      lines.flatMap((line) => {
        const points = projectHullPolyline(100, 80, 24, 0.4, line);
        return [points, points];
      })
    );
    expect(strokes[0]?.points).toHaveLength(outline.hull.points.length);
    expect(strokes.slice(0, 2).map((path) => path.closed)).toEqual([true, true]);
    expect(strokes.filter((_, index) => index % 2 === 1).map((path) => path.color)).toEqual(
      lines.map(() => canvasColor(ctx, PALETTE.LOCAL))
    );
  }
  expect(fill).not.toHaveBeenCalled();
});

test.each(['tow_cable', 'resource_tap', 'boost_coupling'] as const)(
  'each Hauler utility renders a legible attachment silhouette at schematic scale: %s',
  (utility) => {
    const { ctx, strokes } = recordingContext();
    const outline = getKitHullOutline('hauler');
    const equipment = getHaulerEquipment(utility);
    strokes.length = 0;
    strokeKitHullOutline(ctx, 100, 80, 24, 0.4, PALETTE.LOCAL, 'hauler', utility);

    expect(strokes).toHaveLength(2 * (1 + outline.extras.length + equipment.length));
    const renderedEquipment = strokes
      .slice(2 * (1 + outline.extras.length))
      .filter((_, index) => index % 2 === 0)
      .flatMap((stroke) => stroke.points);
    const xValues = renderedEquipment.map(({ x }) => x);
    const yValues = renderedEquipment.map(({ y }) => y);
    expect(Math.max(...xValues) - Math.min(...xValues)).toBeGreaterThan(12);
    expect(Math.max(...yValues) - Math.min(...yValues)).toBeGreaterThan(16);
  }
);

test('local and remote shots retain their glowing artwork and direction, then hits draw a ring and ticks', () => {
  const { ctx, strokes, fill } = recordingContext();
  const local = new Laser({ x: 30, y: 60 }, { x: 3, y: 4 }, 0, 0);
  local.serverId = 'local-diagonal';
  const remote = new Laser({ x: -20, y: 80 }, { x: 0, y: -5 }, 0, 0);
  remote.serverId = 'remote-vertical';
  const viewer = { x: 10, y: 20 };
  const localScreen = canvasManager.worldToScreen(local.position, viewer);
  const remoteScreen = canvasManager.worldToScreen(remote.position, viewer);
  const images: Array<{ source: HTMLCanvasElement; transform: DOMMatrix; x: number; y: number }> =
    [];
  const drawImage = ctx.drawImage.bind(ctx);
  vi.spyOn(ctx, 'drawImage').mockImplementation((...args) => {
    const source = args[0];
    if (!(source instanceof HTMLCanvasElement)) {
      throw new Error('Expected cached bolt artwork');
    }
    images.push({ source, transform: ctx.getTransform(), x: args[1], y: args[2] });
    Reflect.apply(drawImage, ctx, args);
  });
  for (const { shot, screen } of [
    { shot: local, screen: localScreen },
    { shot: remote, screen: remoteScreen },
  ]) {
    images.length = 0;
    strokes.length = 0;
    drawLaserBolts([shot], PALETTE.LASER_LOCAL, viewer);
    expect(images).toHaveLength(1);
    expect(strokes).toEqual([]);
    const artwork = images[0];
    if (!artwork) {
      throw new Error('Shot did not draw its artwork');
    }
    const angle = Math.atan2(shot.velocity.y, shot.velocity.x);
    expect(artwork.transform.a).toBeCloseTo(Math.cos(angle));
    expect(artwork.transform.b).toBeCloseTo(Math.sin(angle));
    expect(artwork.transform.e).toBeCloseTo(screen.x);
    expect(artwork.transform.f).toBeCloseTo(screen.y);
    const sprite = artwork.source.getContext('2d');
    if (!sprite) {
      throw new Error('Cached bolt has no drawing context');
    }
    const x = -artwork.x;
    const y = -artwork.y;
    expect([...sprite.getImageData(x, y, 1, 1).data]).toEqual([255, 248, 225, 255]);
    expect([...sprite.getImageData(x, y + 2, 1, 1).data]).toEqual([253, 230, 138, 255]);
    const trail = sprite.getImageData(x - VISUAL.LASER_LENGTH / 2 - 10, y, 1, 1).data;
    expect(trail[3]).toBeGreaterThan(90);
    expect(trail[3]).toBeLessThan(200);
    expect(sprite.getImageData(x, y + 9, 1, 1).data[3]).toBeGreaterThan(0);
  }
  expect(fill).not.toHaveBeenCalled();

  local.updateExplodeTime();
  strokes.length = 0;
  drawLaserBolts([local], PALETTE.LASER_LOCAL, viewer);
  const ringRadius = VISUAL.LASER_EXPLODE_RADIUS * 0.55;
  const hitTicks = Array.from({ length: VISUAL.LASER_HIT_TICKS }, (_, index) => {
    const tick = burstTick(
      localScreen.x,
      localScreen.y,
      (index * Math.PI * 2) / VISUAL.LASER_HIT_TICKS,
      ringRadius * 0.35,
      ringRadius * 1.35
    );
    return [
      { x: tick.x1, y: tick.y1 },
      { x: tick.x2, y: tick.y2 },
    ];
  }).flat();
  expect(strokes).toHaveLength(2);
  expect(strokes[0]?.arcs[0]).toEqual([
    localScreen.x,
    localScreen.y,
    ringRadius,
    0,
    Math.PI * 2,
    false,
  ]);
  expect(strokes[1]?.points).toEqual(hitTicks);
  expect(strokes[1]?.commands).toEqual(
    Array.from({ length: VISUAL.LASER_HIT_TICKS }, () => ['move', 'line']).flat()
  );
  expect(strokes.map((path) => path.width)).toEqual([1.25, 1]);
  expect(strokes.every((path) => path.color === canvasColor(ctx, PALETTE.LASER_LOCAL))).toBe(true);
  expect(fill).not.toHaveBeenCalled();
});

test('moving pilots reuse both bolt colors and rebuild artwork when display quality changes', () => {
  const { ctx, strokes } = recordingContext();
  const images: HTMLCanvasElement[] = [];
  const transforms: DOMMatrix[] = [];
  const drawImage = ctx.drawImage.bind(ctx);
  vi.spyOn(ctx, 'drawImage').mockImplementation((...args) => {
    const source = args[0];
    if (!(source instanceof HTMLCanvasElement)) {
      throw new Error('Expected cached bolt artwork');
    }
    images.push(source);
    transforms.push(ctx.getTransform());
    Reflect.apply(drawImage, ctx, args);
  });
  const shots = [
    { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, explodeTime: 0, bounceCount: 0 },
    { position: { x: 20, y: 0 }, velocity: { x: 0, y: 1 }, explodeTime: 0, bounceCount: 1 },
  ];
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: 0, y: 0 });
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: 10, y: 20 });
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: -10, y: 5 });
  expect(new Set(images).size).toBe(2);
  expect(images[0]).toBe(images[2]);
  expect(images[1]).toBe(images[3]);
  expect(transforms[0]?.a).toBe(1);
  expect(transforms[0]?.b).toBe(0);
  expect(transforms[1]?.a).toBeCloseTo(0);
  expect(transforms[1]?.b).toBeCloseTo(1);
  expect(strokes).toEqual([]);

  const first = images[0];
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: 0, y: 0 });
  const denser = images[6];
  expect(denser).not.toBe(first);
  expect(denser?.getContext('2d')?.getTransform().a).toBe(2);

  configureRenderQuality('?performance=1&renderGlow=off', false);
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: 0, y: 0 });
  const noGlow = images[8];
  expect(noGlow).not.toBe(denser);
  if (!noGlow || !denser) {
    throw new Error('Quality change did not render bolt artwork');
  }
  expect(noGlow.width).toBeLessThan(denser.width);
  configureRenderQuality('', false);
  drawLaserBolts(shots, PALETTE.LASER_LOCAL, { x: 0, y: 0 });
  expect(images[10]).not.toBe(noGlow);
  expect(images[10]?.width).toBe(denser.width);
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
      const outline = getKitHullOutline(kit.id);
      draw();
      const expected = outline.nozzles.flatMap((nozzle) => {
        const rearX = center.x + 20 * nozzle.f;
        const rearY = center.y + 20 * nozzle.p;
        const outer = [
          { x: rearX, y: rearY + 4 },
          { x: rearX - 13.6, y: rearY },
          { x: rearX, y: rearY - 4 },
        ];
        const inner = [
          { x: rearX, y: rearY + 2.2 },
          { x: rearX - 5.712, y: rearY },
          { x: rearX, y: rearY - 2.2 },
        ];
        return [outer, outer, inner, inner];
      });
      expect(strokes.map((path) => path.points)).toEqual(expected);
      const outerTip = strokes[0]?.points[1];
      const innerTip = strokes[2]?.points[1];
      if (!outerTip || !innerTip) {
        throw new Error('Thrust did not draw both V tips');
      }
      const first = outline.nozzles[0];
      if (!first) {
        throw new Error('Kit is missing a thruster nozzle');
      }
      const rearX = center.x + 20 * first.f;
      const outerReach = rearX - outerTip.x;
      const innerReach = rearX - innerTip.x;
      expect(innerReach).toBeLessThan(outerReach);
      expect(innerReach / outerReach).toBeCloseTo(VISUAL.THRUSTER_CORE_RATIO);
      expect(strokes.map((path) => path.width)).toEqual(
        outline.nozzles.flatMap(() => [1.25, 1.25, 0.9375, 0.9375])
      );
      expect(strokes.map((path) => path.color)).toEqual(
        outline.nozzles.flatMap(() =>
          [0.4, 1, 0.28, 0.7].map((alpha) => canvasColor(ctx, hexToRgba(color, alpha)))
        )
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

test('a destroyed scout breaks into drifting hull edges, an expanding ring and unfilled sparks', () => {
  const { ctx, strokes, fill } = recordingContext();
  const ship = pilot('destroyed-scout').ship;
  ship.kitId = 'scout';
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
  const edges = projectKitHullEdges(400, 300, 20, 0, 'scout');
  expect(edges.length).toBeGreaterThan(6);
  expect(strokes).toHaveLength(1 + edges.length + 2);
  expect(strokes[0]?.arcs[0]).toEqual([400, 300, 52.125, 0, Math.PI * 2]);
  expect(strokes.slice(1, 1 + edges.length).map((path) => path.points)).toEqual(
    edges.map(([a, b]) => {
      const edge = driftSegment(a, b, { x: 400, y: 300 }, 0.5, 41, 0.7);
      return [edge.a, edge.b];
    })
  );
  const firstEdge = strokes[1]?.points;
  const edgeA = firstEdge?.[0];
  const edgeB = firstEdge?.[1];
  if (!edgeA || !edgeB) {
    throw new Error('Destroyed scout did not draw its first drifting hull edge');
  }
  const midX = (edgeA.x + edgeB.x) / 2;
  const midY = (edgeA.y + edgeB.y) / 2;
  expect(Math.hypot(midX - 400, midY - 300)).toBeGreaterThan(5);
  const sparks = strokes[1 + edges.length];
  const ticks = strokes[2 + edges.length];
  expect(sparks?.points).toEqual(
    Array.from({ length: VISUAL.EXPLOSION_SPARKS }, (_, index) => {
      const tick = burstTick(
        400,
        300,
        0.35 + (index * Math.PI * 2) / VISUAL.EXPLOSION_SPARKS,
        27.125,
        36.125
      );
      return [
        { x: expect.closeTo(tick.x1, 10), y: expect.closeTo(tick.y1, 10) },
        { x: expect.closeTo(tick.x2, 10), y: expect.closeTo(tick.y2, 10) },
      ];
    }).flat()
  );
  expect(sparks?.commands).toEqual(
    Array.from({ length: VISUAL.EXPLOSION_SPARKS }, () => ['move', 'line']).flat()
  );
  expect(ticks?.points).toEqual(
    Array.from({ length: VISUAL.EXPLOSION_HIT_TICKS }, (_, index) => {
      const tick = burstTick(
        400,
        300,
        (index * Math.PI * 2) / VISUAL.EXPLOSION_HIT_TICKS,
        11,
        41.25
      );
      return [
        { x: tick.x1, y: tick.y1 },
        { x: tick.x2, y: tick.y2 },
      ];
    }).flat()
  );
  expect(ticks?.commands).toEqual(
    Array.from({ length: VISUAL.EXPLOSION_HIT_TICKS }, () => ['move', 'line']).flat()
  );
  expect(strokes[0]?.color).toBe(canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575 * 0.85)));
  expect(
    strokes
      .slice(1, 2 + edges.length)
      .every((path) => path.color === canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575)))
  ).toBe(true);
  expect(ticks?.color).toBe(canvasColor(ctx, hexToRgba(PALETTE.LOCAL, 0.575 * 0.75)));
  expect(fill).not.toHaveBeenCalled();
});

test('remote ship lifecycle advances on the shared update clock', () => {
  const remote = pilot('remote-visual', 'remote');
  const updateLifecycle = vi.spyOn(remote.ship, 'updateLifecycle');
  advanceRemotePlayerShips([remote]);
  expect(updateLifecycle).toHaveBeenCalledOnce();
});

test('terrain and contour laser renderers emit finite muted strokes at runtime', () => {
  vi.stubGlobal('Path2D', TestPath2D);
  const { ctx, strokes } = recordingContext();
  const prior = getTerrainField();
  try {
    configureRenderQuality('', false);
    ensureTerrain(TERRAIN.DEFAULT_SEED, { cx: 0, cy: 0, radius: 3100 });
    drawIsoContours({ x: -303, y: 337 }, 0);
    expect(strokes.some((path) => path.points.length > 0)).toBe(true);
    expect(
      strokes
        .flatMap((path) => path.points)
        .every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))
    ).toBe(true);
    expect(
      strokes.every((path) => path.blur === 0 && path.width === VISUAL.CONTOUR_STROKE_WIDTH)
    ).toBe(true);
    // A flat passage has violet RGB even when its opacity varies by distance.
    expect(strokes.some((path) => String(path.color).startsWith('rgba(179, 136, 255,'))).toBe(true);
    strokes.length = 0;
    drawContourLaserTicks({ x: -2100, y: 700 }, [{ x: -2100, y: 700 }]);
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
    expect(VISUAL.CONTOUR_STROKE_WIDTH).toBe(1);
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
  const touchControls = document.querySelector('#touch-controls');
  const oldTouchContent = touchControls?.innerHTML;
  const bodyClass = document.body.className;
  try {
    InputManager.getInstance().initializeListeners();
    const gameCanvas = document.querySelector('#gameCanvas');
    const titleTerrain = document.querySelector('#title-terrain');
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
