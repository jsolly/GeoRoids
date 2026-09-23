import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CIVIC_LOTS } from '../../../shared/furnaces';
import { WORLD } from '../../../shared/world';
import type { ShipKitId } from '../../../shared-types';
import { PALETTE, TITLE, VISUAL } from '../../../src/constants';
import { getKitHullOutline, projectHullPolyline } from '../../../src/entities/ship/hullOutlines';
import { applyShipKitToShip } from '../../../src/entities/ship/shipKits';
import {
  FURNACE_MAP_INK,
  MINIMAP_FURNACE_MARK_SIZE,
} from '../../../src/rendering/hud/furnaceMapMark';

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
  const outlinedRectangles: Array<{
    rectangles: Array<{ x: number; y: number; width: number; height: number }>;
    style: typeof ctx.strokeStyle;
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
    outlinedRectangles.push({ rectangles: [...pathRectangles], style: ctx.strokeStyle });
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
  return { strokes, texts, rectangles, filledPaths, outlinedRectangles };
}

function asteroidSilhouette(x: number, y: number, size: number) {
  return [
    [-0.95, -0.25],
    [-0.5, -0.9],
    [0.15, -1],
    [0.8, -0.55],
    [1, 0.15],
    [0.5, 0.85],
    [-0.25, 1],
    [-0.85, 0.5],
  ].map(([dx = 0, dy = 0]) => [x + dx * size, y + dy * size]);
}

function satellitePanels(x: number, y: number) {
  return [
    { x: x - 0.88, y: y - 1.6, width: 1.76, height: 3.2 },
    { x: x - 4, y: y - 2.6, width: 2.2, height: 5.2 },
    { x: x + 1.8, y: y - 2.6, width: 2.2, height: 5.2 },
  ];
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

function radarPolylinePoints(
  x: number,
  y: number,
  size: number,
  heading: number,
  line: Parameters<typeof projectHullPolyline>[4]
): Array<[number, number]> {
  return projectHullPolyline(x, y, size, heading, line).map((point) => [point.x, point.y]);
}

function radarHullPoints(
  x: number,
  y: number,
  size: number,
  heading: number,
  kitId: ShipKitId
): Array<[number, number]> {
  return radarPolylinePoints(x, y, size, heading, getKitHullOutline(kitId).hull);
}

function radarKitPolylines(
  x: number,
  y: number,
  size: number,
  heading: number,
  kitId: ShipKitId
): Array<{ points: Array<[number, number]>; closed: boolean }> {
  const outline = getKitHullOutline(kitId);
  return [
    { points: radarPolylinePoints(x, y, size, heading, outline.hull), closed: outline.hull.closed },
    ...outline.extras.map((extra) => ({
      points: radarPolylinePoints(x, y, size, heading, extra),
      closed: extra.closed,
    })),
  ];
}

function expectRadarKitMark(
  strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    style: string | CanvasGradient | CanvasPattern;
  }>,
  color: string,
  x: number,
  y: number,
  size: number,
  heading: number,
  kitId: ShipKitId
): void {
  const painted = crispKitStrokes(strokes, color);
  for (const expected of radarKitPolylines(x, y, size, heading, kitId)) {
    expect(painted).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  }
}

function crispKitStrokes(
  strokes: Array<{
    points: Array<[number, number]>;
    closed: boolean;
    style: string | CanvasGradient | CanvasPattern;
  }>,
  color: string
) {
  return strokes.filter((call) => call.style === color);
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

  test('the HUD shows bank, finite cargo, and shared settlement requirements', async () => {
    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { drawScoreOverlay } = await import('../../../src/rendering/hud/gameInfo');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const player = PlayerManager.getInstance().createLocalPlayer('scout');
    player.cargo = 123;
    const ctx = canvasContext();
    const { texts } = recordCanvas(ctx);
    drawScoreOverlay(ctx, computeHudLayout(ctx.canvas, { touchControls: false }), ctx.canvas, 4321);
    expect(texts.some((row) => row.text === 'Bank 4,321')).toBe(true);
    expect(texts.some((row) => row.text.includes('Cargo 123/500'))).toBe(true);
    expect(texts.some((row) => row.text.includes('Settlement 1'))).toBe(true);
    expect(texts.some((row) => row.text.includes('crystal 0/20'))).toBe(true);
  });

  test('the local radar marks only nearby revealed furnaces, leaving distant discoveries to the universe map', async () => {
    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { ExplorationMap } = await import('../../../shared/exploration');
    const { setWorldExploration } = await import('../../../src/network/worldExploration');
    const player = PlayerManager.getInstance().createLocalPlayer('scout');
    player.ship.position = { x: 0, y: 0 };
    const exploration = new ExplorationMap();
    exploration.reveal({ x: 40_000, y: 0 }, 100);
    setWorldExploration(exploration.snapshot());
    const ctx = canvasContext();
    const { strokes, filledPaths } = recordCanvas(ctx);
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });
    const stationInk = normalizedCanvasColor(ctx, FURNACE_MAP_INK);
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);
    expect(strokes.filter(({ style, closed }) => style === stationInk && closed)).toEqual([]);
    exploration.reveal({ x: 0, y: 0 }, 100);
    setWorldExploration(exploration.snapshot());
    strokes.length = 0;
    filledPaths.length = 0;
    drawMiniMap(ctx, layout, player.ship, [], [], [], []);
    const stations = strokes.filter(({ style, closed }) => style === stationInk && closed);
    expect(stations).toHaveLength(1);
    const tip = stations[0]?.points[0];
    expect(tip?.[0]).toBeCloseTo(layout.miniMap.x + layout.miniMap.size / 2, 5);
    expect(tip?.[1]).toBeCloseTo(
      layout.miniMap.y + layout.miniMap.size / 2 - MINIMAP_FURNACE_MARK_SIZE,
      5
    );
    expect(filledPaths.every(({ rectangles }) => rectangles.length === 0)).toBe(true);
  });

  test('An unconfirmed local scan previews minerals and restores generic marks on expiry', async () => {
    const { PlayerManager } = await import('../../../src/entities/player/PlayerManager');
    const { Roid } = await import('../../../src/entities/roid/Roid');
    const { computeHudLayout } = await import('../../../src/rendering/hud/hudLayout');
    const { drawMiniMap } = await import('../../../src/rendering/hud/minimap');
    const { ExplorationMap } = await import('../../../shared/exploration');
    const { setWorldExploration } = await import('../../../src/network/worldExploration');
    const player = PlayerManager.getInstance().createLocalPlayer('scout');
    player.ship.position = { x: 0, y: 0 };
    player.ship.abilityActiveFrames = 1;
    const roids = (['ice', 'metal', 'rubble'] as const).map((material, index) => {
      const rock = new Roid({ x: (index - 1) * 800, y: 0 }, 20, material);
      rock.material = material;
      return rock;
    });
    const ctx = canvasContext();
    const { texts, strokes } = recordCanvas(ctx);
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
    expect(texts.map(({ text }) => text)).toEqual(['ice', 'metal', 'rubble', 'X +0', 'Y +0']);
    for (const [index, color] of ['#A5F3FC', '#FDE68A', '#FDBA74'].entries()) {
      const center = centers[index];
      if (!center) {
        throw new Error('Missing mineral projection');
      }
      const mineral = strokes.find(
        (stroke) =>
          stroke.style === normalizedCanvasColor(ctx, color) &&
          stroke.points[0]?.[0] === center.x - 3.8
      );
      expect(mineral?.closed).toBe(true);
      expect(mineral?.points.slice(0, 8)).toEqual(asteroidSilhouette(center.x, center.y, 4));
      expect(mineral?.points.length).toBeGreaterThan(8);
    }
    player.ship.abilityActiveFrames = 0;
    texts.length = 0;
    strokes.length = 0;
    drawMiniMap(ctx, layout, player.ship, roids, [], [], []);
    expect(texts.map(({ text }) => text)).toEqual(['X +0', 'Y +0']);
    const generic = strokes.find(
      ({ style }) => style === normalizedCanvasColor(ctx, 'rgba(148,163,184,0.65)')
    );
    expect(generic?.closed).toBe(true);
    expect(generic?.points).toEqual(centers.flatMap(({ x, y }) => asteroidSilhouette(x, y, 2.5)));
    expect(
      strokes.some(
        ({ style, points }) => style === normalizedCanvasColor(ctx, '#FDE68A') && points.length > 8
      )
    ).toBe(false);
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
    const player = PlayerManager.getInstance().createLocalPlayer('scout');
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
    applyShipKitToShip(peer.ship, 'hauler');
    const far = entityFactory.createRemotePlayer('radar-far', 'Radar Far', {
      x: 0,
      y: -WORLD.minimapRadius * 2,
    });
    far.ship.angle = 0;
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
    const { strokes, rectangles, filledPaths, outlinedRectangles } = recordCanvas(ctx);
    const arc = vi.spyOn(ctx, 'arc');
    const translate = vi.spyOn(ctx, 'translate');
    const layout = computeHudLayout(ctx.canvas, { touchControls: false });
    const draw = (): void => {
      drawMiniMap(
        ctx,
        layout,
        player.ship,
        roids,
        LootField.getInstance().getAll(),
        SatellitePickupManager.getInstance().getAll(),
        [remote, peer, far]
      );
    };

    draw();

    const darkLotsInRadar = CIVIC_LOTS.filter(
      (lot) => Math.hypot(lot.position.x, lot.position.y) <= WORLD.minimapRadius
    );
    expect(arc.mock.calls[0]).toEqual([736, 536, 48, 0, Math.PI * 2]);
    expect(arc.mock.calls.filter((call) => call[2] === 4)).toHaveLength(darkLotsInRadar.length);
    expect(strokes[0]).toEqual({
      points: [],
      closed: true,
      style: normalizedCanvasColor(ctx, 'rgba(100,116,139,0.85)'),
      width: 1,
    });
    expect(rectangles.some(({ style }) => style === normalizedCanvasColor(ctx, PALETTE.BG))).toBe(
      true
    );
    expect(
      rectangles.filter(({ style }) => style === normalizedCanvasColor(ctx, 'rgba(0, 0, 17, 0.72)'))
    ).toHaveLength(1);
    expect(filledPaths).toHaveLength(1);
    expect(strokes[1]).toEqual({
      points: asteroidSilhouette(760, 536, 2.5),
      closed: true,
      style: normalizedCanvasColor(ctx, 'rgba(148,163,184,0.65)'),
      width: 0.8,
    });
    expect(strokes[2]).toEqual({
      points: [
        [733.4, 526.8],
        [734.8, 522.2],
        [739.2, 520],
        [738.4, 525.6],
        [735.6, 527.6],
        [735.6, 527.6],
        [736.8, 523],
        [739.2, 520],
      ],
      closed: true,
      style: normalizedCanvasColor(ctx, '#E8D5A3'),
      width: 1,
    });
    const satelliteColor = normalizedCanvasColor(ctx, 'rgba(196,181,253,0.95)');
    const panels = outlinedRectangles.filter(({ style }) => style === satelliteColor);
    expect(panels.map((panel) => panel.rectangles)).toEqual([
      [...satellitePanels(736, 560), ...satellitePanels(748, 560)],
      satellitePanels(712, 536),
    ]);
    expect(strokes[3]?.points).toEqual([
      [732, 560],
      [740, 560],
      [736, 558.4],
      [736, 556.4],
      [737.2, 555.6],
      [744, 560],
      [752, 560],
      [748, 558.4],
      [748, 556.4],
      [749.2, 555.6],
    ]);
    expect(strokes[4]?.points).toEqual([
      [708, 536],
      [716, 536],
      [712, 534.4],
      [712, 532.4],
      [713.2, 531.6],
      [718, 536],
    ]);
    const scoutOutline = getKitHullOutline('scout');
    const haulerOutline = getKitHullOutline('hauler');
    const scoutMarks = 1 + scoutOutline.extras.length;
    const haulerMarks = 1 + haulerOutline.extras.length;
    // One arena ring, four world layers, nearby furnace foundations, then kit hulls.
    expect(strokes).toHaveLength(
      1 + 4 + darkLotsInRadar.length + 1 + scoutMarks * 2 * 3 + haulerMarks * 2
    );
    const court = strokes[5 + darkLotsInRadar.length];
    expect(court).toMatchObject({
      closed: false,
      style: normalizedCanvasColor(ctx, PALETTE.REMOTE),
      width: 1.4,
    });
    expect(court?.points).toHaveLength(8);
    // Four open corner panels, painted before the pilot hulls, at the fixed public landmark.
    expect(court?.points[0]?.[0]).toBeCloseTo(2.139, 3);
    expect(court?.points[0]?.[1]).toBeCloseTo(-6.028, 3);
    expect(court?.points[7]?.[0]).toBeCloseTo(-2.139, 3);
    expect(court?.points[7]?.[1]).toBeCloseTo(-6.028, 3);
    expect(
      translate.mock.calls.some(
        ([x, y]) => Math.abs(x - 757.3333) < 0.001 && Math.abs(y - 518.6667) < 0.001
      )
    ).toBe(true);
    const radarX = layout.miniMap.x + layout.miniMap.size / 2;
    const radarY = layout.miniMap.y + layout.miniMap.size / 2;
    const peerX = radarX + layout.miniMap.size / 4;
    const crewX = radarX - layout.miniMap.size / 4;
    const rimRadius = Math.max(8, layout.miniMap.size / 2 - 8);
    const rimX = radarX;
    const rimY = radarY - rimRadius;
    const localColor = normalizedCanvasColor(ctx, player.color);
    const remoteColor = normalizedCanvasColor(ctx, PALETTE.REMOTE);
    expectRadarKitMark(
      strokes,
      localColor,
      radarX,
      radarY,
      VISUAL.MINIMAP_LOCAL_SIZE,
      Math.PI / 2,
      'scout'
    );
    expect(crispKitStrokes(strokes, localColor)).toHaveLength(scoutMarks);
    expectRadarKitMark(strokes, remoteColor, peerX, radarY, VISUAL.MINIMAP_DOT, 0, 'hauler');
    expectRadarKitMark(strokes, remoteColor, crewX, radarY, VISUAL.MINIMAP_DOT, 0, 'scout');
    const rimHeading = Math.PI / 2;
    const canvasInwardHeading = -Math.PI / 2;
    const rimHull = crispKitStrokes(strokes, remoteColor).find(
      (call) =>
        call.closed &&
        call.points.length === scoutOutline.hull.points.length &&
        call.points[0]?.[1] ===
          radarHullPoints(rimX, rimY, VISUAL.MINIMAP_DOT, rimHeading, 'scout')[0]?.[1]
    );
    expect(rimHull?.points.length).toBeGreaterThan(3);
    expect(rimHull?.points).toEqual(
      radarHullPoints(rimX, rimY, VISUAL.MINIMAP_DOT, rimHeading, 'scout')
    );
    expect(rimHull?.points).not.toEqual(
      radarHullPoints(rimX, rimY, VISUAL.MINIMAP_DOT, canvasInwardHeading, 'scout')
    );
    expect(rimHull?.points).not.toEqual(
      radarHullPoints(rimX, rimY, VISUAL.MINIMAP_DOT, 0, 'scout')
    );
    expectRadarKitMark(strokes, remoteColor, rimX, rimY, VISUAL.MINIMAP_DOT, rimHeading, 'scout');
    expect(crispKitStrokes(strokes.slice(6 + darkLotsInRadar.length), remoteColor)).toHaveLength(
      scoutMarks * 2 + haulerMarks
    );

    strokes.length = 0;
    outlinedRectangles.length = 0;
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

    expect(strokes[1]?.points).toEqual(asteroidSilhouette(724, 536, 2.5));
    expect(
      outlinedRectangles.filter(({ style }) => style === satelliteColor).at(-1)?.rectangles
    ).toEqual(satellitePanels(748, 536));
    expect(strokes[4]?.points).toEqual([
      [744, 536],
      [752, 536],
      [748, 534.4],
      [748, 532.4],
      [749.2, 531.6],
      [754, 536],
    ]);

    strokes.length = 0;
    outlinedRectangles.length = 0;
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

    expect(arc.mock.calls[0]).toEqual([736, 536, 48, 0, Math.PI * 2]);
    expect(arc.mock.calls.filter((call) => call[2] === 4)).toHaveLength(darkLotsInRadar.length);
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
