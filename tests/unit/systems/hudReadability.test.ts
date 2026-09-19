import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WORLD } from '../../../shared/world';
import { PALETTE, SHIP, TITLE, VISUAL } from '../../../src/constants';
import { getKitHullOutline } from '../../../src/entities/ship/hullOutlines';
import { layoutHudCluster } from '../../../src/rendering/hud/cluster';
import { FURNACE_MAP_INK } from '../../../src/rendering/hud/furnaceMapMark';

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

  test('three upright life hulls accompany the score and kit', async () => {
    expect(VISUAL.HUD_LIFE_SIZE).toBe(14);
    expect(VISUAL.HUD_LIFE_SIZE).toBeLessThan(SHIP.SIZE / 2);
    expect(VISUAL.HUD_INSET).toBe(16);
    expect(VISUAL.SCORE_FONT).toBe('14px Arial');

    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { drawLivesIndicator } = await import('../../../src/rendering/hud/lives');
    const { drawScoreOverlay } = await import('../../../src/rendering/hud/gameInfo');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const player = PlayerManager.getInstance().createLocalPlayer('surveyor');

    const ctx = canvasContext();
    const { strokes, texts } = recordCanvas(ctx);
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });

    drawLivesIndicator(ctx, layout, 3, PALETTE.LOCAL, player.ship.kitId);
    const hulls = strokes.filter((call) => call.style === normalizedCanvasColor(ctx, '#5EEAD4'));
    const silhouette = getKitHullOutline('surveyor').hull;
    expect(strokes).toHaveLength(6);
    expect(hulls).toHaveLength(3);
    for (const [index, hull] of hulls.entries()) {
      expect(hull.closed).toBe(true);
      expect(hull.points).toHaveLength(silhouette.points.length);
      const xs = hull.points.map(([x]) => x);
      const ys = hull.points.map(([, y]) => y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(6);
      expect(Math.min(...ys)).toBeLessThan(23);
      const centerX = 23 + index * 20;
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(centerX, 0);
    }

    drawScoreOverlay(ctx, layout, ctx.canvas, 4321, 3);
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
        text: 'Surveyor',
        x: 16,
        y: 38,
        style: normalizedCanvasColor(ctx, 'rgba(100,116,139,0.85)'),
        font: '11px Arial',
        align: 'left',
      },
    ]);
  });

  test('the local radar marks only nearby revealed furnaces, leaving distant discoveries to the universe map', async () => {
    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { ExplorationMap } = await import('../../../shared/exploration');
    const { setWorldExploration } = await import('../../../src/network/worldExploration');
    const player = PlayerManager.getInstance().createLocalPlayer('surveyor');
    player.ship.position = { x: 0, y: 0 };
    const exploration = new ExplorationMap();
    exploration.reveal({ x: 4000, y: 0 }, 100);
    setWorldExploration(exploration.snapshot());
    const ctx = canvasContext();
    const { strokes, filledPaths } = recordCanvas(ctx);
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });
    const stationInk = normalizedCanvasColor(ctx, FURNACE_MAP_INK);
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);
    expect(strokes.filter(({ style }) => style === stationInk)).toEqual([]);
    exploration.reveal({ x: 0, y: -660 }, 100);
    setWorldExploration(exploration.snapshot());
    strokes.length = 0;
    filledPaths.length = 0;
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);
    const stations = strokes.filter(({ style, closed }) => style === stationInk && closed);
    expect(stations.length).toBeGreaterThanOrEqual(1);
    expect(filledPaths.every(({ rectangles }) => rectangles.length === 0)).toBe(true);
  });

  test('Surveyor radar classifies minerals during a scan and restores generic marks on expiry', async () => {
    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { Roid } = await import('../../../src/entities/roid/Roid');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { ExplorationMap } = await import('../../../shared/exploration');
    const { setWorldExploration } = await import('../../../src/network/worldExploration');
    const player = PlayerManager.getInstance().createLocalPlayer('surveyor');
    player.ship.position = { x: 0, y: 0 };
    player.ship.abilityActiveFrames = 1;
    const roids = (['ice', 'metal', 'rubble'] as const).map((material, index) => {
      const rock = new Roid({ x: (index - 1) * 800, y: 0 }, 20, material);
      rock.material = material;
      return rock;
    });
    const ctx = canvasContext();
    const { texts, filledPaths } = recordCanvas(ctx);
    const arc = vi.spyOn(ctx, 'arc');
    const line = vi.spyOn(ctx, 'lineTo');
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });
    const centers = [-800, 0, 800].map((x) => ({
      x:
        layout.miniMap.x +
        layout.miniMap.size / 2 +
        (x / WORLD.minimapRadius) * (layout.miniMap.size / 2),
      y: layout.miniMap.y + layout.miniMap.size / 2,
    }));
    const [ice, metal, rubble] = centers;
    if (!ice || !metal || !rubble) {
      throw new Error('All three mineral fixtures must project');
    }
    const exploration = new ExplorationMap();
    for (const rock of roids) {
      exploration.reveal(rock.position, 100);
    }
    setWorldExploration(exploration.snapshot());
    drawMiniMap(ctx, layout, player.ship, roids, [], [], []);
    expect(texts.map(({ text }) => text)).toEqual([
      '○ Ice',
      '□ Metal',
      '△ Rubble',
      'X +0',
      'Y +0 · S0,0',
    ]);
    expect(arc).toHaveBeenCalledWith(ice.x, ice.y, 3, 0, Math.PI * 2);
    expect(
      filledPaths.find(({ style }) => style === normalizedCanvasColor(ctx, '#FDE68A'))?.rectangles
    ).toEqual([{ x: metal.x - 3, y: metal.y - 3, width: 6, height: 6 }]);
    expect(line).toHaveBeenCalledWith(rubble.x + 3.5, rubble.y + 3);
    expect(line).toHaveBeenCalledWith(rubble.x - 3.5, rubble.y + 3);
    expect(filledPaths.some(({ style }) => style === normalizedCanvasColor(ctx, '#FDBA74'))).toBe(
      true
    );
    player.ship.abilityActiveFrames = 0;
    texts.length = 0;
    filledPaths.length = 0;
    arc.mockClear();
    drawMiniMap(ctx, layout, player.ship, roids, [], [], []);
    expect(texts.map(({ text }) => text)).toEqual(['X +0', 'Y +0 · S0,0']);
    expect(arc.mock.calls.every((call) => call[2] !== 3)).toBe(true);
    expect(filledPaths).toHaveLength(2);
    expect(filledPaths[1]?.rectangles).toHaveLength(3);
    expect(
      filledPaths[1]?.rectangles.every(({ width, height }) => width === 1.5 && height === 1.5)
    ).toBe(true);
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
    const { LootField } = await import('../../../src/entities/loot/LootField');
    const { Roid } = await import('../../../src/entities/roid/Roid');
    const { SatellitePickupManager } = await import(
      '../../../src/entities/satellitePickup/SatellitePickupManager'
    );
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { ExplorationMap } = await import('../../../shared/exploration');
    const { setWorldExploration } = await import('../../../src/network/worldExploration');
    const player = PlayerManager.getInstance().createLocalPlayer('surveyor');
    player.ship.position = { x: 0, y: 0 };
    player.ship.angle = Math.PI / 2;
    const visible = new Roid({ x: WORLD.minimapRadius / 2, y: 0 }, 20, 'radar-visible');
    const dead = new Roid({ x: 0, y: WORLD.minimapRadius / 4 }, 20, 'radar-dead');
    dead.health = 0;
    const roids = [visible, dead];
    const exploration = new ExplorationMap();
    exploration.reveal(visible.position, 100);
    exploration.reveal({ x: 0, y: -WORLD.minimapRadius / 4 }, 100);
    exploration.reveal({ x: 0, y: WORLD.minimapRadius / 4 }, 100);
    exploration.reveal({ x: WORLD.minimapRadius / 2, y: 0 }, 100);
    exploration.reveal({ x: 0, y: WORLD.minimapRadius / 2 }, 100);
    exploration.reveal({ x: WORLD.minimapRadius / 4, y: WORLD.minimapRadius / 2 }, 100);
    exploration.reveal({ x: -WORLD.minimapRadius / 2, y: 0 }, 100);
    setWorldExploration(exploration.snapshot());
    const remote = entityFactory.createRemotePlayer('radar-remote', 'Radar Crew', {
      x: -WORLD.minimapRadius / 2,
      y: 0,
    });
    remote.ship.angle = 0;
    const peer = entityFactory.createRemotePlayer('radar-peer', 'Radar Peer', {
      x: WORLD.minimapRadius / 2,
      y: 0,
    });
    peer.ship.angle = 0;
    SatellitePickupManager.getInstance().syncFromServer([
      {
        id: 'radar-pickup',
        name: 'Landsat 7',
        typeId: 'landsat-7',
        assetKey: 'eo/landsat-7',
        position: { x: 0, y: WORLD.minimapRadius / 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 12,
        color: '#C4B5FD',
        state: 'loose',
        ownerId: null,
        health: 50,
        maxHealth: 50,
      },
      {
        id: 'radar-pickup-secondary',
        name: 'Terra',
        typeId: 'terra',
        assetKey: 'eo/terra',
        position: { x: WORLD.minimapRadius / 4, y: WORLD.minimapRadius / 2 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 12,
        color: '#C4B5FD',
        state: 'loose',
        ownerId: null,
        health: 50,
        maxHealth: 50,
      },
      {
        id: 'radar-orbiter',
        name: 'Aqua',
        typeId: 'aqua',
        assetKey: 'eo/aqua',
        position: { x: -WORLD.minimapRadius / 2, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 12,
        color: '#C4B5FD',
        state: 'orbiting',
        ownerId: 'radar-remote',
        health: 50,
        maxHealth: 50,
      },
    ]);
    LootField.getInstance().applySnapshot([
      {
        id: 'radar-shard',
        position: { x: 0, y: -WORLD.minimapRadius / 4 },
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
        SatellitePickupManager.getInstance().getAll(),
        [remote, peer]
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
    expect(
      rectangles.some(({ style }) => style === normalizedCanvasColor(ctx, 'rgba(0, 0, 17, 0.78)'))
    ).toBe(true);
    expect(
      rectangles.filter(({ style }) => style === normalizedCanvasColor(ctx, 'rgba(0, 0, 17, 0.72)'))
    ).toHaveLength(1);
    expect(filledPaths).toHaveLength(2);
    expect(filledPaths[1]).toEqual({
      rectangles: [{ x: 759.25, y: 535.25, width: 1.5, height: 1.5 }],
      style: normalizedCanvasColor(ctx, 'rgba(148,163,184,0.55)'),
    });
    expect(strokes.slice(1, 4)).toEqual([
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
          [738.5, 560],
          [750.5, 560],
        ],
        closed: false,
        style: normalizedCanvasColor(ctx, 'rgba(196,181,253,0.95)'),
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
        style: normalizedCanvasColor(ctx, 'rgba(196,181,253,0.95)'),
        width: 1,
      },
    ]);
    // One arena ring, three batched world marks, then three two-pass pilot hulls.
    expect(strokes).toHaveLength(10);
    const peerHeading = strokes.filter(
      (call) => call.style === normalizedCanvasColor(ctx, peer.color) && call.points[0]?.[0] === 765
    );
    expect(peerHeading).toHaveLength(1);
    expect(peerHeading[0]?.points).toEqual([
      [765, 536],
      [756, 538.5],
      [756, 533.5],
    ]);
    const heading = strokes.filter(
      (call) =>
        call.style === normalizedCanvasColor(ctx, player.color) && call.points[0]?.[0] === 736
    );
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
    const crewHeading = strokes.filter(
      (call) =>
        call.style === normalizedCanvasColor(ctx, remote.color) && call.points[0]?.[0] === 717
    );
    expect(crewHeading).toHaveLength(1);
    expect(crewHeading[0]?.points).toEqual([
      [717, 536],
      [708, 538.5],
      [708, 533.5],
    ]);

    strokes.length = 0;
    filledPaths.length = 0;
    arc.mockClear();
    visible.position = { x: -WORLD.minimapRadius / 4, y: 0 };
    const orbiter = SatellitePickupManager.getInstance().get('radar-orbiter');
    if (!orbiter) {
      throw new Error('Radar orbiter fixture was not created');
    }
    orbiter.position = { x: WORLD.minimapRadius / 4, y: 0 };
    exploration.reveal(visible.position, 100);
    exploration.reveal(orbiter.position, 100);
    setWorldExploration(exploration.snapshot());
    draw();

    expect(filledPaths[1]).toEqual({
      rectangles: [{ x: 723.25, y: 535.25, width: 1.5, height: 1.5 }],
      style: normalizedCanvasColor(ctx, 'rgba(148,163,184,0.55)'),
    });
    const movedOrbiter = strokes.find(
      (call) => call.style === normalizedCanvasColor(ctx, 'rgba(196,181,253,0.95)') && call.closed
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
        name: 'Aqua',
        typeId: 'aqua',
        assetKey: 'eo/aqua',
        position: { x: WORLD.minimapRadius / 4, y: 0 },
        velocity: { x: 0, y: 0 },
        angle: 0,
        radius: 12,
        color: '#C4B5FD',
        state: 'orbiting',
        ownerId: 'radar-remote',
        health: 50,
        maxHealth: 50,
      },
    ]);
    LootField.getInstance().clear();
    roids.length = 0;
    draw();

    expect(arc.mock.calls).toEqual([[736, 536, 48, 0, Math.PI * 2]]);
    expect(filledPaths).toHaveLength(1);
    expect(strokes.filter((call) => call.style === normalizedCanvasColor(ctx, '#E8D5A3'))).toEqual(
      []
    );
    expect(
      strokes.filter((call) => call.style === normalizedCanvasColor(ctx, 'rgba(196,181,253,0.95)'))
    ).toHaveLength(1);
  });
});

test('locked palette hexes stay the #415/#435 playfield swatch', () => {
  expect(PALETTE).toEqual({
    BG: '#000011',
    STARS: '#8BA3C7',
    LOCAL: '#5EEAD4',
    REMOTE: '#7DD3FC',
    ROID: '#94A3B8',
    CONTOUR: '#5A6B7D',
    LASER_LOCAL: '#FDE68A',
    HUD: '#E2E8F0',
    HUD_MUTED: '#64748B',
    DANGER: '#F43F5E',
    HEALTH: '#4ADE80',
    LOOT: '#E8D5A3',
    SATELLITE: '#C4B5FD',
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
