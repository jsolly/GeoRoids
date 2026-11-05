import { afterEach, expect, test, vi } from 'vitest';
import { drawLootRelative } from '../../../src/entities/loot/lootRenderer';
import { Roid } from '../../../src/entities/roid/Roid';
import { clearAsteroidShatters, drawRoidsRelative } from '../../../src/entities/roid/roidRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { drawLaserBolts } from '../../../src/entities/ship/shipRenderer';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import * as raster from '../../../src/rendering/rasterSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import { asteroidRow } from '../../support/asteroid-row';

afterEach(() => {
  drawLootRelative(new Ship(), []);
  clearAsteroidShatters();
  canvasManager.destroy();
  configureRenderQuality('', 'desktop');
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

function scene(glow: 'off' | 'full', physicalDpr = 1.5) {
  window.history.replaceState(
    null,
    '',
    glow === 'off' ? '/?performance=collect&renderGlow=off' : '/'
  );
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
  const dpr = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(physicalDpr);
  const resizeFrames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    resizeFrames.push(callback);
    return resizeFrames.length;
  });
  const canvas = document.createElement('canvas');
  canvasManager.initialize(canvas);
  const ctx = canvasManager.requireContext();
  // Give every case its own cold laser-color baseline before measuring work.
  drawLaserBolts([], '#fedcba', { x: 0, y: 0 });
  const prepare = vi.spyOn(raster, 'prepareRasterSurface');
  const images = vi.spyOn(ctx, 'drawImage');
  const ship = new Ship({ position: { x: 0, y: 0 } });
  const rock = new Roid(asteroidRow({ x: -100, y: 0 }, 30, 'scan-rock'));
  const rocks = [rock];
  const loot = {
    id: 'scan-loot',
    position: { x: 0, y: 0 },
    kind: 'points' as const,
    radius: 14,
    mass: 0,
  };
  const laser = { position: { x: 100, y: 0 }, velocity: { x: 1, y: 0 }, explodeTime: 0 };
  return {
    ctx,
    dpr,
    rock,
    rocks,
    prepare,
    resize() {
      window.dispatchEvent(new Event('resize'));
      for (const callback of resizeFrames.splice(0)) {
        callback(0);
      }
    },
    frame(now: number, target = 0.3) {
      prepare.mockClear();
      images.mockClear();
      canvasManager.easeZoomToward(target, now);
      canvasManager.beginWorldLayers(ctx);
      const transform = ctx.getTransform();
      try {
        drawRoidsRelative(ship, rocks);
        drawLootRelative(ship, [loot]);
        drawLaserBolts([laser], '#abcdef', ship.position);
      } finally {
        canvasManager.endWorldLayers(ctx);
      }
      const draws = images.mock.calls.map(([source, ...placement]) => {
        if (!(source instanceof HTMLCanvasElement)) {
          throw new Error('Expected cached world artwork');
        }
        return { source, placement, width: source.width, height: source.height };
      });
      return { draws, transform, rebuilt: prepare.mock.calls.map((call) => call[3]) };
    },
  };
}

test('reduced-glow scan easing reuses all three raster families at flight resolution through the return', () => {
  const view = scene('off');
  const flight = view.frame(0, 1);
  expect(flight.rebuilt).toHaveLength(3);
  expect(flight.draws).toHaveLength(3);
  for (let frame = 1; frame <= 90; frame++) {
    const zoomed = view.frame(frame * 16, frame < 45 ? 0.3 : 1);
    expect(zoomed.rebuilt).toEqual([]);
    expect(zoomed.draws.map(({ source }) => source)).toEqual(
      flight.draws.map(({ source }) => source)
    );
    expect(zoomed.draws.map(({ width, height }) => [width, height])).toEqual(
      flight.draws.map(({ width, height }) => [width, height])
    );
    // Artwork stays in the same world coordinates; only the camera transform changes.
    expect(zoomed.draws.map(({ placement }) => placement.slice(-2))).toEqual(
      flight.draws.map(({ placement }) => placement.slice(-2))
    );
    expect(zoomed.transform.a).toBeLessThanOrEqual(1.5);
  }
});

test('a real DPR change, changed asteroid geometry and glow changes still repaint during a scan', () => {
  const view = scene('off');
  view.frame(0);
  view.frame(16);
  view.dpr.mockReturnValue(1.500001);
  view.resize();
  expect(view.frame(32).rebuilt).toHaveLength(3);
  expect(view.frame(48).rebuilt).toEqual([]);
  view.rock.offsets = view.rock.offsets.map((offset) => offset * 0.9);
  expect(view.frame(64).rebuilt).toEqual(['Asteroid silhouette canvas context unavailable']);
  configureRenderQuality('', 'desktop');
  expect(view.frame(80).rebuilt).toHaveLength(3);
});

test('full-glow scan easing retains exact transformed resolution for its backing-pixel halos', () => {
  const view = scene('full');
  view.frame(0);
  const first = view.frame(16);
  const next = view.frame(32);
  expect(first.rebuilt).toHaveLength(3);
  expect(next.rebuilt).toHaveLength(3);
  expect(next.transform.a).toBeLessThan(first.transform.a);
  expect(next.draws.map(({ width, height }) => [width, height])).not.toEqual(
    first.draws.map(({ width, height }) => [width, height])
  );
});

test.each([
  { count: 129, radius: 30, dpr: 1.5 },
  { count: 12, radius: 120, dpr: 4 },
])(
  'a reduced-glow scan of $count rocks retains the 128-surface and 8-million-pixel limits at DPR $dpr',
  ({ count, radius, dpr }) => {
    const view = scene('off', dpr);
    view.rocks.splice(
      0,
      1,
      ...Array.from(
        { length: count },
        (_, index) => new Roid(asteroidRow({ x: 0, y: 0 }, radius, `crowded-${index}`))
      )
    );
    const initial = view.frame(0);
    const admitted = initial.rebuilt.filter(
      (label) => label === 'Asteroid silhouette canvas context unavailable'
    ).length;
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThan(count);
    expect(admitted).toBeLessThanOrEqual(128);
    const asteroidImages = initial.draws.slice(0, admitted);
    expect(
      asteroidImages.reduce((pixels, image) => pixels + image.width * image.height, 0)
    ).toBeLessThanOrEqual(8_000_000);
    for (let frame = 1; frame <= 5; frame++) {
      const scanned = view.frame(frame * 16);
      expect(scanned.rebuilt).toEqual([]);
      expect(scanned.draws.map(({ source }) => source)).toEqual(
        initial.draws.map(({ source }) => source)
      );
    }
  }
);
