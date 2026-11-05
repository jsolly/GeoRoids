import { afterEach, expect, test, vi } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import { CIVIC_LOTS, civicLot, TOWN_HEARTH } from '../../../shared/furnaces';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { Roid } from '../../../src/entities/roid/Roid';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import {
  setWorldExploration,
  setWorldMapAssets,
  worldFurnaces,
} from '../../../src/network/worldExploration';
import { setSpiderField } from '../../../src/physics/terrain/spiderSession';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { setPlayView } from '../../../src/ui/uiUtils';
import {
  bindUniverseMapField,
  mountUniverseMap as mountMap,
  type UniverseMapChrome,
  type UniverseMapController,
} from '../../../src/ui/universeMap';
import { asteroidRow } from '../../support/asteroid-row';

let controller: UniverseMapController | undefined;
let chrome: UniverseMapChrome | undefined;
let clock = 0;

function closeMap() {
  controller?.dispose();
  controller = undefined;
}

afterEach(() => {
  closeMap();
  bindUniverseMapField(() => []);
  setSpiderField(undefined);
  worldFurnaces.replaceLit([]);
  setWorldMapAssets([]);
  setWorldExploration([]);
  setPlayView(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureRenderQuality('', 'desktop');
});

function mountUniverseMap() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([]);
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Expected a map canvas');
  }
  const open = () => {
    closeMap();
    controller = mountMap(canvas, (next) => {
      chrome = next;
    });
  };
  const allLocations = () => {
    if (!chrome || !controller) {
      throw new Error('Expected map chrome');
    }
    const rows: string[] = [];
    const pages = chrome.locationPages;
    for (let page = 0; page < pages; page++) {
      controller.setLocationPage(page);
      clock += 100;
      window.dispatchEvent(new Event('resize'));
      rows.push(...chrome.locations);
      expect(chrome.locations.length).toBeLessThanOrEqual(24);
    }
    return rows.join(' ');
  };
  return { open, canvas, ctx, allLocations };
}

test('keyboard and semantic chart actions signal the panned center without repeating or stealing buttons', () => {
  const { open } = mountUniverseMap();
  const pilot = new Player({
    id: 'chart-signal',
    name: 'Navigator',
    type: 'local',
  });
  pilot.ship.position = { x: 10000, y: 10000 };
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
  const send = vi.spyOn(ConnectionManager.getInstance(), 'sendMessage').mockReturnValue(true);
  open();
  if (!controller) {
    throw new Error('Missing chart controller');
  }
  controller.keydown(new KeyboardEvent('keydown', { code: 'Enter', shiftKey: true }));
  expect(send).toHaveBeenLastCalledWith({
    type: 'crewAction',
    id: pilot.id,
    data: { kind: 'signal', signal: 'help', position: { x: 10000, y: 10000 } },
  });
  controller.keydown(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
  controller.keydown(new KeyboardEvent('keydown', { code: 'Enter', shiftKey: true }));
  const positioned = send.mock.calls[1]?.[0];
  expect(positioned?.data).toMatchObject({ kind: 'signal', signal: 'help' });
  if (positioned?.type !== 'crewAction' || positioned.data.kind !== 'signal') {
    throw new Error('Missing signal position');
  }
  expect(positioned.data.position.x).toBeGreaterThan(10000);
  expect(positioned.data.position.y).toBeCloseTo(10000);
  controller.signalHelpAtCenter();
  expect(send.mock.calls[2]?.[0]).toEqual(positioned);
  controller.keydown(new KeyboardEvent('keydown', { code: 'Enter', shiftKey: true, repeat: true }));
  const buttonEvent = new KeyboardEvent('keydown', { code: 'Enter', shiftKey: true });
  const button = document.createElement('button');
  button.addEventListener('keydown', controller.keydown);
  button.dispatchEvent(buttonEvent);
  expect(send).toHaveBeenCalledTimes(3);
  controller.dispose();
  controller.signalHelpAtCenter();
  expect(send).toHaveBeenCalledTimes(3);
});

test('a pilot pinches the universe chart, keeps dragging after lifting one finger, and locates home', () => {
  const { open, canvas, ctx } = mountUniverseMap();
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
  setWorldMapAssets([
    { id: 'foundation:a', kind: 'foundation', name: 'A', position: { x: 0, y: 0 } },
    { id: 'foundation:b', kind: 'foundation', name: 'B', position: { x: 1_000, y: 0 } },
  ]);
  const marks: Array<{ x: number; y: number }> = [];
  const arc = ctx.arc.bind(ctx);
  vi.spyOn(ctx, 'arc').mockImplementation(function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D['arc']>
  ) {
    if (this.getLineDash().length > 0) {
      const transform = this.getTransform();
      marks.push({ x: transform.e, y: transform.f });
    }
    arc(...args);
  });
  const draw = () => {
    marks.length = 0;
    window.dispatchEvent(new Event('resize'));
    expect(marks).toHaveLength(2);
    const [a, b] = marks;
    if (!a || !b) {
      throw new Error('Missing foundation marks');
    }
    return { a: { ...a }, distance: b.x - a.x };
  };
  const pointer = (type: string, id: number, x: number, y: number) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    canvas.dispatchEvent(event);
  };
  open();
  const initial = draw();
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  pointer('pointerdown', 1, 150, 200);
  pointer('pointerdown', 2, 250, 200);
  pointer('pointermove', 2, 350, 200);
  const pinched = draw();
  expect(pinched.distance).toBeCloseTo(initial.distance * 2);
  expect(pinched.a.x).toBeCloseTo(initial.a.x + 50 * dpr);
  expect(pinched.a.y).toBeCloseTo(initial.a.y);
  pointer('pointerup', 2, 350, 200);
  pointer('pointermove', 1, 170, 210);
  const dragged = draw();
  expect(dragged.distance).toBeCloseTo(pinched.distance);
  expect(dragged.a.x).toBeCloseTo(pinched.a.x + 20 * dpr);
  expect(dragged.a.y).toBeCloseTo(pinched.a.y + 10 * dpr);
  pointer('pointercancel', 1, 170, 210);
  pointer('pointermove', 1, 300, 300);
  expect(draw()).toEqual(dragged);
  controller?.center();
  expect(draw()).toEqual(initial);
  pointer('pointerdown', 3, 150, 200);
  closeMap();
  open();
  pointer('pointermove', 3, 300, 300);
  expect(draw()).toEqual(initial);
});

test('the universe map draws a fire trail only for a lit furnace', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing furnace lot');
  }
  const { open, ctx } = mountUniverseMap();
  const fireTrail = () => {
    let count = 0;
    const spy = vi.spyOn(ctx, 'stroke').mockImplementation(function stroke(
      this: CanvasRenderingContext2D
    ) {
      if (String(this.strokeStyle).includes('244, 63, 94')) {
        count += 1;
      }
    });
    open();
    spy.mockRestore();
    closeMap();
    return count;
  };
  expect(fireTrail()).toBe(0);
  worldFurnaces.light(furnace.id, 'Ada');
  expect(fireTrail()).toBe(1);
});

test('a low-end pilot sees their ship, landmarks and fire trail on the universe map without glow', () => {
  const furnace = civicLot('street-1-0');
  if (!furnace) {
    throw new Error('Missing furnace lot');
  }
  const { open, ctx } = mountUniverseMap();
  setWorldMapAssets([
    {
      id: `furnace:${TOWN_HEARTH.id}`,
      kind: 'furnace',
      name: TOWN_HEARTH.name,
      position: { ...TOWN_HEARTH.position },
    },
  ]);
  worldFurnaces.light(furnace.id, 'Ada');
  const pilot = new Player({ id: 'low-end-pilot', name: 'Ada', type: 'local' });
  pilot.ship.position = { ...TOWN_HEARTH.position };
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
  type Paint = { blur: number; trail: boolean; hull: boolean };
  const paintsAt = (audience: 'desktop' | 'low-end'): Paint[] => {
    configureRenderQuality('', audience);
    const paints: Paint[] = [];
    const stroke = ctx.stroke;
    const fill = ctx.fill;
    vi.spyOn(ctx, 'stroke').mockImplementation(function (this: CanvasRenderingContext2D, ...args) {
      // The fire trail's outer stroke is the danger red the trail test above keys on.
      const trail = String(this.strokeStyle).includes('244, 63, 94');
      paints.push({ blur: this.shadowBlur, trail, hull: false });
      Reflect.apply(stroke, this, args);
    });
    vi.spyOn(ctx, 'fill').mockImplementation(function (this: CanvasRenderingContext2D, ...args) {
      // The local pilot's chart hull is the only fill whose shadow takes the ship colour.
      const hull = String(this.shadowColor) === String(pilotShadow);
      paints.push({ blur: this.shadowBlur, trail: false, hull });
      Reflect.apply(fill, this, args);
    });
    open();
    vi.mocked(ctx.stroke).mockRestore();
    vi.mocked(ctx.fill).mockRestore();
    closeMap();
    return paints;
  };
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) {
    throw new Error('Expected a probe canvas');
  }
  probe.shadowColor = pilot.ship.color;
  const pilotShadow = probe.shadowColor;
  const full = paintsAt('desktop');
  const fullTrail = full.filter((paint) => paint.trail);
  const fullHull = full.filter((paint) => paint.hull);
  expect(fullTrail.length).toBeGreaterThan(0);
  expect(fullHull.length).toBeGreaterThan(0);
  expect(Math.min(...fullTrail.map((paint) => paint.blur))).toBeGreaterThan(0);
  expect(Math.min(...fullHull.map((paint) => paint.blur))).toBeGreaterThan(0);
  const lowEnd = paintsAt('low-end');
  expect(lowEnd.length).toBe(full.length);
  expect(Math.max(...lowEnd.map((paint) => paint.blur))).toBe(0);
});

test('the universe map marks furnace lots before that ground is explored', () => {
  const { open, ctx, allLocations } = mountUniverseMap();
  const salvage = {
    id: 'loot:salvage',
    kind: 'wreckage' as const,
    name: 'Cargo',
    position: { x: 1_000, y: 1_000 },
  };
  setWorldMapAssets([
    {
      id: `furnace:${TOWN_HEARTH.id}`,
      kind: 'furnace',
      name: TOWN_HEARTH.name,
      position: { ...TOWN_HEARTH.position },
    },
    ...CIVIC_LOTS.map((lot) => ({
      id: `furnace:${lot.id}`,
      kind: 'foundation' as const,
      name: lot.name,
      position: { ...lot.position },
    })),
    salvage,
  ]);
  const draw = (): { rings: number; text: string } => {
    let rings = 0;
    const arc = ctx.arc.bind(ctx);
    const spy = vi.spyOn(ctx, 'arc').mockImplementation(function ring(
      this: CanvasRenderingContext2D,
      ...args: Parameters<CanvasRenderingContext2D['arc']>
    ) {
      if (this.getLineDash().length > 0) {
        rings += 1;
      }
      arc(...args);
    });
    open();
    spy.mockRestore();
    const text = allLocations();
    closeMap();
    return { rings, text };
  };
  const hidden = draw();
  expect(hidden.rings).toBe(CIVIC_LOTS.length);
  for (const lot of CIVIC_LOTS) {
    expect(hidden.text).toContain(lot.name);
  }
  expect(hidden.text).toContain(TOWN_HEARTH.name);
  expect(hidden.text).not.toContain(salvage.name);
  const explored = new ExplorationMap();
  explored.reveal(salvage.position, 400);
  setWorldExploration(explored.snapshot());
  const revealed = draw();
  expect(revealed.rings).toBe(CIVIC_LOTS.length);
  expect(revealed.text).toContain(salvage.name);
});

test('the shared chart turns a discovered nest dark gray after its last guard dies', () => {
  const { open, ctx } = mountUniverseMap();
  const position = { x: 500, y: 500 };
  const explored = new ExplorationMap();
  explored.reveal(position, 400);
  setWorldExploration(explored.snapshot());
  const colors: string[] = [];
  vi.spyOn(ctx, 'stroke').mockImplementation(function (this: CanvasRenderingContext2D) {
    colors.push(String(this.strokeStyle));
  });
  for (const cleared of [false, true]) {
    setSpiderField({ spiders: [], nests: [{ id: '0,0', resourceId: 'ore', position, cleared }] });
    colors.length = 0;
    open();
    expect(colors).toContain(cleared ? '#444444' : '#f43f5e');
    closeMap();
  }
});

test('universe chart hides an unlit glow crystal and shows its charged mark in explored ground', () => {
  clock = 0;
  const { open, canvas, ctx } = mountUniverseMap();
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
  const pilot = new Player({
    id: 'glow-chart',
    name: 'Observer',
    type: 'local',
  });
  const origin = { x: 10000, y: 10000 };
  pilot.ship.position = origin;
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
  const ordinary = new Roid(asteroidRow({ x: origin.x + 600, y: origin.y }, 14, 'chart-control'));
  const crystal = new Roid(
    asteroidRow({ x: origin.x + 600, y: origin.y + 300 }, 14, 'chart-crystal')
  );
  crystal.glowtoy = { charge: 0, cachePosition: origin, cacheRevealed: true };
  const exploration = new ExplorationMap();
  exploration.reveal(origin, 1200);
  setWorldExploration(exploration.snapshot());
  setWorldMapAssets([]);
  let shown: Roid[] = [];
  bindUniverseMapField(() => shown);
  const paint = (rocks: Roid[]) => {
    shown = rocks;
    open();
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const empty = paint([]);
  const control = paint([ordinary]);
  expect(control.some((value, i) => value !== empty[i])).toBe(true);
  const unlit = paint([ordinary, crystal]);
  expect(unlit.every((value, i) => value === control[i])).toBe(true);
  crystal.glowtoy.charge = 0.8;
  const lit = paint([ordinary, crystal]);
  expect(lit.some((value, i) => value !== control[i])).toBe(true);
});
