import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WORLD } from '../../../shared/world';
import { Player } from '../../../src/entities/player/Player';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { setAtlasSyncing, setWorldMapAssets } from '../../../src/network/worldExploration';
import {
  FURNACE_MAP_CAMPFIRE_ZOOM,
  FURNACE_MAP_FAR_ZOOM,
} from '../../../src/rendering/hud/furnaceMapMark';
import {
  drawSpawnChart,
  mapScreenDeltaToWorld,
  mountUniverseMap,
  UNIVERSE_MAP_ZOOM,
  type UniverseMapChrome,
  type UniverseMapController,
} from '../../../src/ui/universeMap';

let map: UniverseMapController | undefined;
let clock = 0;
let paintFrame: FrameRequestCallback | undefined;
let canvas: HTMLCanvasElement;
let latest: UniverseMapChrome;
const published = vi.fn<(chrome: UniverseMapChrome) => void>();
const disconnect = vi.fn();

beforeEach(() => {
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
  vi.spyOn(network, 'getAllPlayers').mockReturnValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      paintFrame = callback;
      return 7;
    })
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect = disconnect;
    }
  );
  published.mockClear();
  disconnect.mockClear();
  setAtlasSyncing(true);
  canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
});
afterEach(() => {
  map?.dispose();
  map = undefined;
  setAtlasSyncing(true);
  setWorldMapAssets([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function start() {
  map = mountUniverseMap(canvas, (next) => {
    latest = next;
    published(next);
  });
  return map;
}
function frame(delta = 100) {
  clock += delta;
  paintFrame?.(clock);
}
function key(code: string) {
  const event = new KeyboardEvent('keydown', { code, cancelable: true, bubbles: true });
  map?.keydown(event);
  frame();
  return event;
}

describe('a mounted universe chart', () => {
  test('publishes syncing and completion even when the location list stays unchanged', () => {
    start();
    expect(latest.atlasSyncing).toBe(true);
    const locations = latest.locations;
    setAtlasSyncing(false);
    frame();
    expect(latest.atlasSyncing).toBe(false);
    expect(latest.locations).toEqual(locations);
    setAtlasSyncing(true);
    frame();
    expect(latest.atlasSyncing).toBe(true);
    expect(published).toHaveBeenCalledTimes(3);
  });

  test('keeps zoom bounded and projects world coordinates from the active view', () => {
    expect(FURNACE_MAP_CAMPFIRE_ZOOM).toBe(UNIVERSE_MAP_ZOOM.initial);
    expect(FURNACE_MAP_FAR_ZOOM).toBe(UNIVERSE_MAP_ZOOM.min);
  });

  test('north-up chart pan preserves world bearings', () => {
    const pan = mapScreenDeltaToWorld(0, -40, 2);
    expect(pan).toEqual({ x: 0, y: -20 });
    const pilot = new Player({
      id: 'heading-pilot',
      name: 'Heading Pilot',
      type: 'local',
    });
    pilot.ship.angle = Math.PI / 2;
    pilot.ship.velocity = { x: 4, y: 0 };
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
    start();
  });

  test('Home and Locate restore the nearby ship view after pan and zoom, and gameplay keys are consumed', () => {
    const pilot = new Player({
      id: 'map-pilot',
      name: 'Map Pilot',
      type: 'local',
    });
    pilot.ship.position = { x: 4000, y: 0 };
    vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockReturnValue(pilot);
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore();
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas context unavailable');
    }
    const scale = vi.spyOn(context, 'scale');
    const expectZoom = (zoom: number) => {
      const expected = (latest.frame.size / (WORLD.radius * 2)) * zoom;
      expect(scale.mock.calls[0]?.[0]).toBeCloseTo(expected, 12);
      expect(scale.mock.calls[0]?.[1]).toBeCloseTo(expected, 12);
    };
    const controller = start();
    expect(latest.centered).toBe(true);
    expect(key('Equal').defaultPrevented).toBe(true);
    expect(latest.centered).toBe(false);
    controller.center();
    frame();
    expect(latest.centered).toBe(true);
    key('Equal');
    key('Minus');
    expect(latest.centered).toBe(true);
    key('ArrowRight');
    expect(latest.centered).toBe(false);
    key('Home');
    expect(latest.centered).toBe(true);
    for (const code of ['Space', 'KeyE', 'KeyA', 'KeyD', 'ShiftLeft', 'ShiftRight']) {
      expect(key(code).defaultPrevented).toBe(true);
    }
    scale.mockClear();
    controller.zoomBy(0.0001);
    frame();
    expectZoom(1);
    scale.mockClear();
    controller.zoomBy(1000);
    frame();
    expectZoom(48);
    const wheel = new WheelEvent('wheel', {
      deltaY: 1,
      clientX: 200,
      clientY: 200,
      cancelable: true,
    });
    scale.mockClear();
    canvas.dispatchEvent(wheel);
    frame();
    expect(wheel.defaultPrevented).toBe(true);
    expectZoom(48 / UNIVERSE_MAP_ZOOM.step);
  });

  test('publishes at most ten chrome updates per second and every location remains reachable by page', () => {
    setWorldMapAssets(
      Array.from({ length: 57 }, (_, i) => ({
        id: `site:${i}`,
        kind: 'foundation',
        name: `Site ${i}`,
        position: { x: i, y: 0 },
      }))
    );
    const controller = start();
    expect(latest.locations).toHaveLength(24);
    expect(latest.locationPages).toBe(3);
    const all = [...latest.locations];
    controller.setLocationPage(1);
    for (let i = 0; i < 9; i++) {
      frame(10);
    }
    expect(published).toHaveBeenCalledTimes(1);
    frame(10);
    expect(latest.locationPage).toBe(1);
    all.push(...latest.locations);
    controller.setLocationPage(2);
    frame();
    all.push(...latest.locations);
    for (let i = 0; i < 57; i++) {
      expect(all.some((row) => row.startsWith(`Site ${i} (`))).toBe(true);
    }
    frame();
    expect(published).toHaveBeenCalledTimes(3);
    controller.setLocationPage(99);
    frame();
    expect(latest.locationPage).toBe(2);
  });

  test('resize updates frame geometry and disposal releases a pinch even after the canvas detaches', () => {
    const captures = new Set<number>();
    canvas.setPointerCapture = (id) => {
      captures.add(id);
    };
    canvas.hasPointerCapture = (id) => captures.has(id);
    const release = vi.fn((id: number) => {
      captures.delete(id);
    });
    canvas.releasePointerCapture = release;
    const controller = start();
    expect(latest.frame.size).toBe(552);
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 400, 400));
    frame();
    expect(latest.frame.size).toBe(324);
    for (const pointerId of [11, 22]) {
      const event = new Event('pointerdown', { cancelable: true });
      Object.assign(event, {
        pointerId,
        pointerType: 'touch',
        button: 0,
        clientX: pointerId,
        clientY: 30,
      });
      canvas.dispatchEvent(event);
    }
    expect([...captures]).toEqual([11, 22]);
    canvas.remove();
    controller.dispose();
    controller.dispose();
    expect(release.mock.calls).toEqual([[11], [22]]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    const calls = published.mock.calls.length;
    controller.zoomBy(2);
    frame();
    expect(published).toHaveBeenCalledTimes(calls);
    expect(key('Space').defaultPrevented).toBe(false);
    document.body.append(canvas);
    start();
    expect(latest.centered).toBe(true);
  });

  test('spawn chart painting stays usable without mounting any map DOM', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore();
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Expected canvas context');
    }
    const translate = vi.spyOn(context, 'translate');
    drawSpawnChart(context, 400, 300, { x: 50, y: 60 }, 0.5);
    expect(translate).toHaveBeenCalledWith(200, 150);
    expect(translate).toHaveBeenCalledWith(-50, -60);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
