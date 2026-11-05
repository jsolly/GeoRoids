import { afterEach, expect, test, vi } from 'vitest';
import { WORLD_BOUNDARY } from '../../../shared/boundary';
import { FurnaceField } from '../../../shared/furnaceField';
import { createHeightfield } from '../../../shared/heightfield';
import { COURT_REFLECTORS } from '../../../shared/ricochetCourt';
import type {
  AsteroidProbe,
  CampaignSnapshot,
  LootKind,
  TerrainSpider,
} from '../../../shared-types';
import { Laser } from '../../../src/entities/laser/Laser';
import { createPlayer } from '../../../src/entities/player/createPlayer';
import { Roid } from '../../../src/entities/roid/Roid';
import { SatellitePickup } from '../../../src/entities/satellitePickup/SatellitePickup';
import * as terrainSession from '../../../src/physics/terrain/terrainSession';
import { getBeltRecovery, setBeltRecovery } from '../../../src/rendering/beltRenderer';
import {
  SimpleScanRenderer,
  type SimpleScanScene,
  type SimpleScanView,
} from '../../../src/rendering/simpleScanRenderer';

const view: SimpleScanView = {
  viewport: { width: 800, height: 600 },
  viewer: { x: 0, y: 0 },
  worldScale: 0.2,
  zoom: 0.2,
  now: 1500,
  serverNow: 1500,
};

function scene(): SimpleScanScene {
  const localPlayer = createPlayer({
    id: 'local',
    name: 'Pilot',
    type: 'local',
    position: { x: 0, y: 0 },
  });
  localPlayer.ship.blinkCount = 0;
  return {
    localPlayer,
    players: [localPlayer],
    roids: [],
    loot: [],
    lootBlast: null,
    pickups: [],
    spiders: { spiders: [], nests: [] },
    recovery: [],
    rolyPolys: [],
    bridges: [],
    remains: [],
    campaign: undefined,
    terrain: createHeightfield(100, WORLD_BOUNDARY),
    furnaces: new FurnaceField(),
    exploration: [],
  };
}

function canvas() {
  const element = document.createElement('canvas');
  element.width = 800;
  element.height = 600;
  const ctx = element.getContext('2d');
  if (!ctx) {
    throw new Error('Expected real canvas');
  }
  return ctx;
}

function rock(id: string, x: number, y: number): Roid {
  return new Roid({
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    size: 30,
    health: 50,
    maxHealth: 100,
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    jaggedness: 0.2,
    material: 'metal',
  });
}

function spider(id: string, x: number, y: number): TerrainSpider {
  return {
    id,
    position: { x, y },
    angle: 0,
    health: 30,
    maxHealth: 60,
    phase: 'hunting',
    targetId: 'local',
  };
}

function probe(id: string): AsteroidProbe {
  return {
    id,
    ownerId: 'local',
    health: 25,
    maxHealth: 50,
    attachedAt: 0,
    expiresAt: 100000,
    angle: 0,
    radialOffset: 30,
  };
}

function campaign(): CampaignSnapshot {
  return {
    projectValue: 0,
    supplies: [],
    hives: [
      {
        kind: 'hive',
        id: 'queen',
        position: { x: 300, y: 200 },
        frontier: 'initial',
        queenHealth: 300,
        birthFramesLeft: 480,
        clearedAt: null,
        sacs: [25, 0],
        sacDeadline: 5000,
        sacsCompletedAt: null,
        restoredValue: 0,
        contributors: [],
        commissionedAt: null,
        shieldOpen: false,
      },
    ],
    commissioned: [],
    cleared: [],
    hazard: { phase: 'active', kind: 'meteors', startsAt: 0, endsAt: 10000 },
    meteors: [{ id: 'meteor', position: { x: 500, y: -300 } }],
  };
}

afterEach(() => {
  setBeltRecovery();
  vi.restoreAllMocks();
});

test('a cached Scan keeps spiders, unmatched crawlers, queens, meteors, probes, blast and reformation warnings live', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  const arcs = vi.spyOn(ctx, 'arc'),
    lines = vi.spyOn(ctx, 'lineTo'),
    labels = vi.spyOn(ctx, 'fillText');
  const detailed = vi.spyOn(terrainSession, 'getTerrainContours');
  const deposit = rock('deposit', -500, -200);
  deposit.probe = probe('rock-probe');
  const hunter = spider('hunter', 100, 100);
  hunter.probe = probe('spider-probe');
  const crawler = spider('crawler', -200, 400);
  crawler.crawler = {
    hostId: 'absent-host',
    anchor: { x: -200, y: 400 },
    phase: 'lunging',
    progress: 0.5,
  };
  state.roids = [deposit];
  state.spiders = { spiders: [hunter, crawler], nests: [] };
  state.campaign = campaign();
  state.lootBlast = { position: { x: -600, y: 300 }, radius: 80 };
  setBeltRecovery([{ slot: 1, position: { x: 700, y: 500 }, size: 75, recoverAt: 3000 }]);
  state.recovery = getBeltRecovery();
  const first = renderer.draw(ctx, view, state);
  expect(first).toMatchObject({
    terrainBuilt: true,
    terrainSamples: 1089,
    visibleAsteroids: 1,
    visibleSpiders: 2,
    visibleMeteors: 1,
  });
  const hasCircleAt = (x: number, y: number) =>
    arcs.mock.calls.some((call) => call[0] === x && call[1] === y);
  expect(hasCircleAt(420, 320)).toBe(true); // Hunter at its live pose.
  expect(hasCircleAt(360, 380)).toBe(true); // Escaping or unmatched-host crawler is never hidden.
  expect(hasCircleAt(460, 340)).toBe(true); // Queen.
  expect(hasCircleAt(505, 340)).toBe(true); // Living sac, 225 world units right of queen.
  expect(hasCircleAt(500, 240)).toBe(true); // Meteor.
  expect(arcs).toHaveBeenCalledWith(280, 360, 16, 0, Math.PI * 2); // Actual blast radius.
  expect(arcs).toHaveBeenCalledWith(540, 400, 18, 0, Math.PI * 2); // Reformation radius and marker margin.
  expect(hasCircleAt(306, 260)).toBe(true); // Probe anchored to asteroid.
  expect(hasCircleAt(426, 320)).toBe(true); // Probe anchored to spider.
  expect(labels).toHaveBeenCalledWith('QUEEN SHIELDED', 460, 365);
  expect(lines.mock.calls.length).toBeGreaterThan(0);
  expect(detailed).not.toHaveBeenCalled();

  arcs.mockClear();
  labels.mockClear();
  hunter.position.x = 200;
  crawler.position.y = 500;
  state.lootBlast = null;
  state.recovery = [];
  state.campaign.meteors = [];
  const hive = state.campaign.hives[0];
  if (!hive) {
    throw new Error('Expected hive');
  }
  hive.shieldOpen = true;
  const second = renderer.draw(ctx, view, state);
  expect(second).toMatchObject({
    terrainBuilt: false,
    terrainSamples: 0,
    visibleSpiders: 2,
    visibleMeteors: 0,
  });
  expect(hasCircleAt(420, 320)).toBe(false);
  expect(hasCircleAt(440, 320)).toBe(true);
  expect(hasCircleAt(360, 400)).toBe(true);
  expect(hasCircleAt(500, 240)).toBe(false);
  expect(hasCircleAt(280, 360)).toBe(false);
  expect(hasCircleAt(540, 400)).toBe(false);
  expect(labels.mock.calls.some(([label]) => label === 'QUEEN EXPOSED')).toBe(true);
  expect(detailed).not.toHaveBeenCalled();
});

test('live shots project exactly once across zoom and a bounced bolt keeps its danger ink', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  state.localPlayer.ship.lasers = [new Laser({ x: 100, y: 200 }, { x: 10, y: 0 }, 0, 0)];
  const shot = state.localPlayer.ship.lasers[0];
  if (!shot) {
    throw new Error('Expected shot');
  }
  shot.bounceCount = 1;
  const moves = vi.spyOn(ctx, 'moveTo');
  const strokes: string[] = [];
  const original = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push(String(ctx.strokeStyle));
    original();
  });
  const first = renderer.draw(ctx, view, state);
  expect(first.visibleShots).toBe(1);
  expect(moves).toHaveBeenCalledWith(420, 340);
  expect(strokes).toContain('#f43f5e');
  moves.mockClear();
  shot.position = { x: 120, y: 240 };
  renderer.draw(ctx, { ...view, worldScale: 0.5, zoom: 0.5 }, state);
  expect(moves).toHaveBeenCalledWith(460, 420);
  shot.hasExploded = true;
  expect(renderer.draw(ctx, view, state).visibleShots).toBe(0);
});

test('all resource kinds remain distinct, hidden glow rocks stay hidden, and stored satellites stay hidden', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  const kinds: LootKind[] = [
    'shard',
    'silk',
    'points',
    'tap',
    'resource_tap',
    'boost_coupling',
    'survey_probe',
  ];
  state.loot = kinds.map((kind, index) => ({
    id: kind,
    kind,
    position: { x: -600 + index * 200, y: -500 },
    mass: 1,
    radius: 10,
  }));
  state.roids = ['ice', 'metal', 'rubble', 'crystal'].map((material, index) => {
    const deposit = rock(material, -600 + index * 200, -300);
    if (
      material === 'ice' ||
      material === 'metal' ||
      material === 'rubble' ||
      material === 'crystal'
    ) {
      deposit.material = material;
    }
    return deposit;
  });
  const dark = rock('dark', 700, -300);
  dark.glowtoy = { charge: 0, cachePosition: { x: 800, y: -300 }, cacheRevealed: false };
  state.roids = [...state.roids, dark];
  const strokes: string[] = [];
  const original = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push(String(ctx.strokeStyle));
    original();
  });
  const labels = vi.spyOn(ctx, 'fillText');
  const satellite = new SatellitePickup({
    id: 'satellite',
    name: 'Aqua',
    typeId: 'aqua',
    assetKey: 'eo/aqua',
    position: { x: 500, y: 500 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    radius: 10,
    color: '#123abc',
    state: 'stored',
    ownerId: 'local',
    health: 50,
    maxHealth: 50,
  });
  state.pickups = [satellite];
  const result = renderer.draw(ctx, view, state);
  expect(result).toMatchObject({ visibleAsteroids: 4, visibleLoot: 7 });
  expect(strokes).not.toContain('#123abc');
  satellite.state = 'orbiting';
  renderer.draw(ctx, view, state);
  expect(strokes).toContain('#123abc');
  expect(strokes).toEqual(expect.arrayContaining(['#a5f3fc', '#fde68a', '#fdba74', '#d8b4fe']));
  for (const label of ['TAP', 'RESOURCE TAP', 'BOOST COUPLING', 'SURVEY PROBE']) {
    expect(labels.mock.calls.some(([text]) => text === label)).toBe(true);
  }
});

test('a single bounded terrain patch survives zoom and live changes, then replaces on field, movement, and reset', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  expect(renderer.draw(ctx, { ...view, worldScale: 1, zoom: 1 }, state).terrainSamples).toBe(1089);
  expect(renderer.draw(ctx, view, state).terrainBuilt).toBe(false);
  state.terrain = createHeightfield(101, WORLD_BOUNDARY);
  expect(renderer.draw(ctx, view, state).terrainSamples).toBe(1089);
  expect(
    renderer.draw(ctx, { ...view, viewer: { x: 20000, y: 20000 } }, state).terrainSamples
  ).toBe(1089);
  renderer.reset();
  expect(renderer.draw(ctx, view, state).terrainSamples).toBe(1089);
});

test('the live boundary and ricochet fields remain visible and a current tow target moves without changing ship state', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  const arcs = vi.spyOn(ctx, 'arc'),
    lines = vi.spyOn(ctx, 'lineTo');
  const boundaryView = {
    ...view,
    viewer: { x: WORLD_BOUNDARY.cx + WORLD_BOUNDARY.radius, y: WORLD_BOUNDARY.cy },
  };
  renderer.draw(ctx, boundaryView, state);
  expect(arcs).toHaveBeenCalledWith(
    400 - WORLD_BOUNDARY.radius * 0.2,
    300,
    WORLD_BOUNDARY.radius * 0.2,
    0,
    Math.PI * 2
  );
  const reflector = COURT_REFLECTORS[0];
  if (!reflector) {
    throw new Error('Expected reflector');
  }
  renderer.draw(ctx, { ...view, viewer: reflector.start }, state);
  expect(lines).toHaveBeenCalledWith(
    400 + (reflector.end.x - reflector.start.x) * 0.2,
    300 + (reflector.end.y - reflector.start.y) * 0.2
  );
  const target = rock('target', 100, 200);
  state.roids = [target];
  state.localPlayer.ship.harpoonTargetId = target.id;
  state.localPlayer.ship.harpoonLatchPos = { x: -10, y: -10 };
  renderer.draw(ctx, view, state);
  expect(lines).toHaveBeenCalledWith(420, 340);
  target.position.x = 200;
  renderer.draw(ctx, view, state);
  expect(lines).toHaveBeenCalledWith(440, 340);
  expect(state.localPlayer.ship.harpoonLatchPos).toEqual({ x: -10, y: -10 });
});

test('an offscreen host still shows its attached probe pulse crossing the viewport and fallback clears inherited composition', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  const host = rock('offscreen', 2200, 0);
  host.probe = probe('offscreen-beacon');
  state.roids = [host];
  const arcs = vi.spyOn(ctx, 'arc');
  const compositions: string[] = [];
  const original = ctx.fillRect.bind(ctx);
  vi.spyOn(ctx, 'fillRect').mockImplementation((x, y, width, height) => {
    compositions.push(ctx.globalCompositeOperation);
    original(x, y, width, height);
  });
  ctx.globalCompositeOperation = 'destination-out';
  const result = renderer.draw(ctx, view, state);
  expect(result.visibleAsteroids).toBe(0);
  expect(arcs).toHaveBeenCalledWith(846, 300, 60, 0, Math.PI * 2);
  expect(compositions[0]).toBe('source-over');
  expect(ctx.globalCompositeOperation).toBe('destination-out');
});

test('the live Mineral Scan timer expands a cyan pulse to the shared scan range without glow', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  state.localPlayer.ship.kitId = 'scout';
  state.localPlayer.ship.r = 20;
  state.localPlayer.ship.abilityActiveFrames = 90;
  const pulses: { x: number; y: number; radius: number; glow: number }[] = [];
  const originalArc = ctx.arc.bind(ctx);
  vi.spyOn(ctx, 'arc').mockImplementation((x, y, radius, start, end, counterclockwise) => {
    if (ctx.strokeStyle === '#67e8f9') {
      pulses.push({ x, y, radius, glow: ctx.shadowBlur });
    }
    originalArc(x, y, radius, start, end, counterclockwise);
  });
  renderer.draw(ctx, view, state);
  expect(pulses).toEqual([{ x: 400, y: 300, radius: 63, glow: 0 }]);
  pulses.length = 0;
  state.localPlayer.ship.abilityActiveFrames = 60;
  renderer.draw(ctx, view, state);
  expect(pulses).toEqual([{ x: 400, y: 300, radius: 122, glow: 0 }]);
  pulses.length = 0;
  state.localPlayer.ship.abilityActiveFrames = 0;
  renderer.draw(ctx, view, state);
  expect(pulses).toEqual([]);
});

test('reported primitive and glyph path counts match actual canvas strokes', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  state.roids = [rock('one-rock', 100, 200)];
  state.loot = [
    { id: 'one-shard', kind: 'shard', mass: 1, radius: 10, position: { x: -100, y: -200 } },
  ];
  const strokes = vi.spyOn(ctx, 'stroke');
  const result = renderer.draw(ctx, view, state);
  expect(result.glyphPaths).toBe(2);
  expect(strokes).toHaveBeenCalledTimes(1 + result.primitivePaths + result.glyphPaths);
});

test('reformation countdown follows the current server deadline and replacement or removal takes effect immediately', () => {
  const renderer = new SimpleScanRenderer(),
    ctx = canvas(),
    state = scene();
  state.recovery = [{ slot: 1, position: { x: 700, y: 500 }, size: 75, recoverAt: 5000 }];
  const labels = vi.spyOn(ctx, 'fillText');
  renderer.draw(ctx, view, state);
  expect(labels).toHaveBeenCalledWith('REFORMING 4s', 540, 379);
  labels.mockClear();
  renderer.draw(ctx, { ...view, serverNow: 4000 }, state);
  expect(labels).toHaveBeenCalledWith('REFORMING 1s', 540, 379);
  labels.mockClear();
  state.recovery = [{ slot: 1, position: { x: 500, y: 500 }, size: 75, recoverAt: 10000 }];
  renderer.draw(ctx, { ...view, serverNow: 4000 }, state);
  expect(labels).toHaveBeenCalledWith('REFORMING 6s', 500, 379);
  expect(labels).not.toHaveBeenCalledWith('REFORMING 1s', 540, 379);
  labels.mockClear();
  state.recovery = [];
  renderer.draw(ctx, { ...view, serverNow: 5000 }, state);
  expect(labels.mock.calls.some(([text]) => text.startsWith('REFORMING'))).toBe(false);
});
