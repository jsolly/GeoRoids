import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PALETTE, SHIP, TITLE, VISUAL } from '../../../src/constants';
import { layoutHudCluster } from '../../../src/rendering/hud/cluster';
import { projectWorldToMiniMap } from '../../../src/rendering/hud/minimap';

function recordCanvas(ctx: CanvasRenderingContext2D) {
  let points: Array<[number, number]> = [];
  let closed = false;
  const strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    style: typeof ctx.strokeStyle;
    width: number;
  }> = [];
  const texts: Array<{
    text: string;
    x: number;
    y: number;
    style: typeof ctx.fillStyle;
    font: string;
    align: CanvasTextAlign;
  }> = [];
  const rectangles: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    style: typeof ctx.fillStyle;
  }> = [];
  const filledPaths: Array<{
    rectangles: Array<{ x: number; y: number; width: number; height: number }>;
    style: typeof ctx.fillStyle;
  }> = [];
  let pathRectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
  const beginPath = ctx.beginPath.bind(ctx);
  const moveTo = ctx.moveTo.bind(ctx);
  const lineTo = ctx.lineTo.bind(ctx);
  const closePath = ctx.closePath.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  const fill = ctx.fill.bind(ctx);
  const rect = ctx.rect.bind(ctx);
  const fillText = ctx.fillText.bind(ctx);
  const fillRect = ctx.fillRect.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    closed = false;
    pathRectangles = [];
    beginPath();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push([x, y]);
    moveTo(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push([x, y]);
    lineTo(x, y);
  });
  vi.spyOn(ctx, 'closePath').mockImplementation(() => {
    closed = true;
    closePath();
  });
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push({ points: [...points], closed, style: ctx.strokeStyle, width: ctx.lineWidth });
    stroke();
  });
  vi.spyOn(ctx, 'rect').mockImplementation((x, y, width, height) => {
    pathRectangles.push({ x, y, width, height });
    rect(x, y, width, height);
  });
  vi.spyOn(ctx, 'fill').mockImplementation((...args) => {
    filledPaths.push({ rectangles: [...pathRectangles], style: ctx.fillStyle });
    fill(...args);
  });
  vi.spyOn(ctx, 'fillText').mockImplementation((...args) => {
    const [text, x, y] = args;
    texts.push({ text, x, y, style: ctx.fillStyle, font: ctx.font, align: ctx.textAlign });
    fillText(...args);
  });
  vi.spyOn(ctx, 'fillRect').mockImplementation((x, y, width, height) => {
    rectangles.push({ x, y, width, height, style: ctx.fillStyle });
    fillRect(x, y, width, height);
  });
  return { strokes, texts, rectangles, filledPaths };
}

function canvasContext(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('HUD scenarios require the real JSDOM canvas context');
  }
  return ctx;
}

function normalizedCanvasColor(ctx: CanvasRenderingContext2D, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  const normalized = ctx.fillStyle;
  ctx.restore();
  return normalized;
}

describe('painted HUD composition', () => {
  const removeListeners: Array<() => void> = [];
  let controllerDescriptor: PropertyDescriptor | undefined;
  let storedClientId: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    controllerDescriptor = Object.getOwnPropertyDescriptor(window, 'gameController');
    storedClientId = sessionStorage.getItem('georoids.clientId');
    const addListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      addListener(type, listener, options);
      removeListeners.push(() => window.removeEventListener(type, listener, options));
    });
  });

  afterEach(() => {
    for (const remove of removeListeners.splice(0)) {
      remove();
    }
    if (controllerDescriptor) {
      Object.defineProperty(window, 'gameController', controllerDescriptor);
    } else {
      Reflect.deleteProperty(window, 'gameController');
    }
    if (storedClientId === null) {
      sessionStorage.removeItem('georoids.clientId');
    } else {
      sessionStorage.setItem('georoids.clientId', storedClientId);
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('three upright life hulls accompany the score, faction, kit and half-full fuel bar', async () => {
    expect(VISUAL.HUD_LIFE_SIZE).toBe(14);
    expect(VISUAL.HUD_LIFE_SIZE).toBeLessThan(SHIP.SIZE / 2);
    expect(VISUAL.HUD_INSET).toBe(16);
    expect(VISUAL.SCORE_FONT).toBe('14px Arial');

    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { drawLivesIndicator } = await import('../../../src/rendering/hud/lives');
    const { drawScoreOverlay } = await import('../../../src/rendering/hud/gameInfo');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const player = PlayerManager.getInstance().createLocalPlayer('dart');
    player.ship.fuel = player.ship.maxFuel / 2;
    const ctx = canvasContext();
    const { strokes, texts } = recordCanvas(ctx);
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });

    drawLivesIndicator(ctx, layout, 3, PALETTE.LOCAL, player.ship.kitId);
    const hulls = strokes.filter((call) => call.style === normalizedCanvasColor(ctx, '#5EEAD4'));
    expect(strokes).toHaveLength(6);
    expect(hulls).toHaveLength(3);
    for (const [index, hull] of hulls.entries()) {
      expect(hull.closed).toBe(true);
      expect(hull.points).toHaveLength(6);
      const nose = hull.points[0];
      if (!nose) {
        throw new Error('Life hull has no nose');
      }
      expect(nose[0]).toBeCloseTo(23 + index * 20);
      expect(nose[1]).toBeCloseTo(14.3375);
      const xs = hull.points.map(([x]) => x);
      const ys = hull.points.map(([, y]) => y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2.275);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(17.325);
      expect(nose[1]).toBe(Math.min(...ys));
    }

    drawScoreOverlay(ctx, layout, ctx.canvas, 4321, 3, 'ion');
    expect(texts).toEqual([
      {
        text: '4321',
        x: 80,
        y: 23,
        style: normalizedCanvasColor(ctx, '#E2E8F0'),
        font: '14px Arial',
        align: 'left',
      },
      {
        text: 'ION',
        x: 27,
        y: 38,
        style: normalizedCanvasColor(ctx, 'rgba(168,160,200,0.85)'),
        font: '11px Arial',
        align: 'left',
      },
      {
        text: 'Dart',
        x: 16,
        y: 52,
        style: normalizedCanvasColor(ctx, 'rgba(100,116,139,0.85)'),
        font: '11px Arial',
        align: 'left',
      },
    ]);
    expect(strokes.slice(-2)).toEqual([
      {
        points: [
          [16, 70],
          [88, 70],
        ],
        closed: false,
        style: normalizedCanvasColor(ctx, '#64748B'),
        width: 2,
      },
      {
        points: [
          [16, 70],
          [52, 70],
        ],
        closed: false,
        style: normalizedCanvasColor(ctx, '#E8D5A3'),
        width: 2,
      },
    ]);
  });

  test('radar paints moving world marks and keeps pilots above live objects', async () => {
    expect(VISUAL.MINIMAP_SIZE).toBe(96);
    expect(VISUAL.MINIMAP_VOID_ALPHA).toBeLessThanOrEqual(0.5);
    expect(VISUAL.MINIMAP_VOID_ALPHA).toBeGreaterThan(0);
    expect(VISUAL.MINIMAP_RING_ALPHA).toBeGreaterThan(0.5);
    expect(VISUAL.MINIMAP_DOT).toBeGreaterThanOrEqual(4);
    expect(VISUAL.MINIMAP_LOCAL_SIZE).toBeGreaterThan(VISUAL.MINIMAP_DOT / 2);

    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { entityFactory } = await import('../../../src/entities/EntityFactory');
    const { NetworkManager } = await import('../../../src/network/networkManager');
    const { LootField } = await import('../../../src/entities/loot/LootField');
    const { Roid } = await import('../../../src/entities/roid/Roid');
    const { SatelliteManager } = await import('../../../src/entities/satellite/SatelliteManager');
    const { SatellitePickupManager } = await import(
      '../../../src/entities/satellitePickup/SatellitePickupManager'
    );
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { getGameBoundary } = await import('../../../src/physics/boundary');
    const player = PlayerManager.getInstance().createLocalPlayer('dart');
    player.ship.position = { x: 0, y: 0 };
    player.ship.angle = Math.PI / 2;
    const boundary = getGameBoundary();
    const visible = new Roid({ x: boundary.radius / 2, y: 0 }, 20, 'radar-visible');
    const dead = new Roid({ x: 0, y: boundary.radius / 4 }, 20, 'radar-dead');
    dead.health = 0;
    const roids = [visible, dead];
    const remote = entityFactory.createRemotePlayer('radar-remote', 'Radar Rival', {
      x: -boundary.radius / 2,
      y: 0,
    });
    remote.ship.angle = 0;
    const bot = entityFactory.createBotPlayer('Radar Bot', {
      x: boundary.radius / 2,
      y: 0,
    });
    bot.ship.angle = 0;
    vi.spyOn(NetworkManager.getInstance(), 'getAllPlayers').mockReturnValue([player, remote, bot]);
    SatelliteManager.getInstance().syncFromServer([
      {
        id: 'radar-satellite',
        name: 'Landsat 7',
        typeId: 'landsat-7',
        assetKey: 'eo/landsat-7',
        shotManner: 'steady-optical-ping',
        position: { x: 0, y: -boundary.radius / 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        exploding: false,
        color: '#C4B5FD',
        health: 100,
        maxHealth: 100,
        radius: 22,
      },
      {
        id: 'radar-dead-satellite',
        name: 'Terra',
        typeId: 'terra',
        assetKey: 'eo/terra',
        shotManner: 'wide-modis-sweep',
        position: { x: boundary.radius / 4, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        exploding: true,
        color: '#C4B5FD',
        health: 100,
        maxHealth: 100,
        radius: 22,
      },
    ]);
    SatellitePickupManager.getInstance().syncFromServer([
      {
        id: 'radar-pickup',
        name: 'Echo',
        typeId: 'echo',
        assetKey: 'pickup/echo',
        position: { x: 0, y: boundary.radius / 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 15,
        color: '#FBBF24',
        state: 'loose',
        ownerId: null,
        health: 50,
        maxHealth: 50,
      },
      {
        id: 'radar-pickup-secondary',
        name: 'Echo',
        typeId: 'echo',
        assetKey: 'pickup/echo',
        position: { x: boundary.radius / 4, y: boundary.radius / 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 15,
        color: '#FBBF24',
        state: 'loose',
        ownerId: null,
        health: 50,
        maxHealth: 50,
      },
      {
        id: 'radar-orbiter',
        name: 'Relay',
        typeId: 'relay',
        assetKey: 'pickup/relay',
        position: { x: -boundary.radius / 2, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 15,
        color: '#FBBF24',
        state: 'orbiting',
        ownerId: 'radar-remote',
        health: 50,
        maxHealth: 50,
      },
    ]);
    LootField.getInstance().applySnapshot([
      {
        id: 'radar-shard',
        position: { x: 0, y: -boundary.radius / 4 },
        mass: 0.25,
        radius: 8,
        kind: 'shard',
      },
    ]);
    const ctx = canvasContext();
    const { strokes, rectangles, filledPaths } = recordCanvas(ctx);
    const arc = vi.spyOn(ctx, 'arc');
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });
    const draw = (): void => {
      drawMiniMap(
        ctx,
        layout,
        player.ship,
        roids,
        LootField.getInstance().getAll(),
        SatelliteManager.getInstance().getAll(),
        SatellitePickupManager.getInstance().getAll()
      );
    };

    draw();

    expect(arc.mock.calls).toEqual([
      [736, 536, 48, 0, Math.PI * 2],
      [736, 560, 2.5, 0, Math.PI * 2],
      [748, 560, 2.5, 0, Math.PI * 2],
    ]);
    expect(strokes[0]).toEqual({
      points: [],
      closed: true,
      style: normalizedCanvasColor(ctx, 'rgba(100,116,139,0.85)'),
      width: 1,
    });
    expect(rectangles).toEqual([]);
    expect(filledPaths).toHaveLength(2);
    expect(filledPaths[1]).toEqual({
      rectangles: [{ x: 759.25, y: 535.25, width: 1.5, height: 1.5 }],
      style: normalizedCanvasColor(ctx, 'rgba(148,163,184,0.55)'),
    });
    expect(strokes.slice(1, 5)).toEqual([
      {
        points: [
          [736, 522],
          [738, 524],
          [736, 526],
          [734, 524],
        ],
        closed: true,
        style: normalizedCanvasColor(ctx, '#E8D5A3'),
        width: 1,
      },
      {
        points: [
          [734, 512],
          [738, 512],
          [736, 510],
          [736, 514],
        ],
        closed: false,
        style: normalizedCanvasColor(ctx, 'rgba(196,181,253,0.9)'),
        width: 1,
      },
      {
        points: [
          [738.5, 560],
          [750.5, 560],
        ],
        closed: false,
        style: normalizedCanvasColor(ctx, 'rgba(251,191,36,0.95)'),
        width: 1,
      },
      {
        points: [
          [712, 533],
          [715, 536],
          [712, 539],
          [709, 536],
        ],
        closed: true,
        style: normalizedCanvasColor(ctx, 'rgba(251,191,36,0.95)'),
        width: 1,
      },
    ]);
    // One arena ring, four batched world marks, then three two-pass pilot hulls.
    expect(strokes).toHaveLength(11);
    const botHeading = strokes.filter(
      (call) => call.style === normalizedCanvasColor(ctx, '#FB923C')
    );
    expect(botHeading).toHaveLength(1);
    expect(botHeading[0]?.points).toEqual([
      [765, 536],
      [756, 538.5],
      [756, 533.5],
    ]);
    const heading = strokes.filter((call) => call.style === normalizedCanvasColor(ctx, '#5EEAD4'));
    expect(heading).toHaveLength(1);
    const hull = heading[0];
    if (!hull) {
      throw new Error('Radar did not draw the local heading');
    }
    expect(hull.closed).toBe(true);
    expect(hull.points).toEqual([
      [736, 530],
      [739, 540.8],
      [733, 540.8],
    ]);
    const rivalHeading = strokes.filter(
      (call) => call.style === normalizedCanvasColor(ctx, '#7DD3FC')
    );
    expect(rivalHeading).toHaveLength(1);
    expect(rivalHeading[0]?.points).toEqual([
      [717, 536],
      [708, 538.5],
      [708, 533.5],
    ]);

    strokes.length = 0;
    filledPaths.length = 0;
    arc.mockClear();
    visible.position = { x: -boundary.radius / 4, y: 0 };
    const orbiter = SatellitePickupManager.getInstance().get('radar-orbiter');
    if (!orbiter) {
      throw new Error('Radar orbiter fixture was not created');
    }
    orbiter.position = { x: boundary.radius / 4, y: 0 };
    draw();

    expect(filledPaths[1]).toEqual({
      rectangles: [{ x: 723.25, y: 535.25, width: 1.5, height: 1.5 }],
      style: normalizedCanvasColor(ctx, 'rgba(148,163,184,0.55)'),
    });
    const movedOrbiter = strokes.find(
      (call) => call.style === normalizedCanvasColor(ctx, 'rgba(251,191,36,0.95)') && call.closed
    );
    expect(movedOrbiter?.points).toEqual([
      [748, 533],
      [751, 536],
      [748, 539],
      [745, 536],
    ]);

    strokes.length = 0;
    filledPaths.length = 0;
    arc.mockClear();
    SatellitePickupManager.getInstance().syncFromServer([
      {
        id: 'radar-orbiter',
        name: 'Relay',
        typeId: 'relay',
        assetKey: 'pickup/relay',
        position: { x: boundary.radius / 4, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 15,
        color: '#FBBF24',
        state: 'orbiting',
        ownerId: 'radar-remote',
        health: 50,
        maxHealth: 50,
      },
    ]);
    SatelliteManager.getInstance().syncFromServer([]);
    LootField.getInstance().clear();
    roids.length = 0;
    draw();

    expect(arc.mock.calls).toEqual([[736, 536, 48, 0, Math.PI * 2]]);
    expect(filledPaths).toHaveLength(1);
    expect(strokes.filter((call) => call.style === normalizedCanvasColor(ctx, '#E8D5A3'))).toEqual(
      []
    );
    expect(
      strokes.filter((call) => call.style === normalizedCanvasColor(ctx, 'rgba(251,191,36,0.95)'))
    ).toHaveLength(1);
  });
});

test('locked palette hexes stay the #415/#435 playfield swatch', () => {
  expect(PALETTE).toEqual({
    BG: '#000011',
    STARS: '#8BA3C7',
    LOCAL: '#5EEAD4',
    REMOTE: '#7DD3FC',
    BOT: '#FB923C',
    ROID: '#94A3B8',
    CONTOUR: '#5A6B7D',
    LASER_LOCAL: '#FDE68A',
    LASER_ENEMY: '#FCA5A5',
    HUD: '#E2E8F0',
    HUD_MUTED: '#64748B',
    DANGER: '#F43F5E',
    HEALTH: '#4ADE80',
    LOOT: '#E8D5A3',
    SHIELD: '#7DD3C8',
    SATELLITE: '#C4B5FD',
    SATELLITE_PICKUP: '#FBBF24',
  });
  expect(TITLE.ACCENT).toBe('#A78BFA');
  expect(PALETTE).not.toHaveProperty('ACCENT_UI');
});

test('layoutHudCluster keeps three lives and the score in one compact strip', () => {
  const three = layoutHudCluster(3);
  expect(three.lifeCenters).toHaveLength(3);
  expect(three.lifeCenters[0]).toEqual({
    x: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
    y: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
  });
  const last = three.lifeCenters[2];
  const first = three.lifeCenters[0];
  expect(first).toBeDefined();
  expect(last).toBeDefined();
  if (!first || !last) {
    throw new Error('expected three life centers');
  }
  expect(three.score.x).toBeGreaterThan(last.x + VISUAL.HUD_LIFE_SIZE / 2);
  expect(three.score.x).toBeLessThan(120);
  expect(three.score.y).toBe(first.y);

  const none = layoutHudCluster(0);
  expect(none.lifeCenters).toEqual([]);
  expect(none.score).toEqual({
    x: VISUAL.HUD_INSET,
    y: VISUAL.HUD_INSET + VISUAL.HUD_LIFE_SIZE / 2,
  });
});

test('projectWorldToMiniMap maps the arena center to the radar center', () => {
  const boundary = { cx: 0, cy: 0, radius: 100 };
  const center = projectWorldToMiniMap(boundary, 0, 0, 80, 0, 0);
  expect(center).toEqual({ x: 40, y: 40 });

  const east = projectWorldToMiniMap(boundary, 0, 0, 80, 100, 0);
  expect(east).toEqual({ x: 80, y: 40 });
  expect(east).not.toBe(center);
  expect(center).toEqual({ x: 40, y: 40 });

  const outside = projectWorldToMiniMap(boundary, 0, 0, 80, 400, 0, 10);
  expect(outside).toBeNull();
});
