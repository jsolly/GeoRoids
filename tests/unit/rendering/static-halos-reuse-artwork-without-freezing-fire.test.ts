import { afterEach, expect, test, vi } from 'vitest';
import { ExplorationMap } from '../../../shared/exploration';
import { CIVIC_LOTS, TOWN_HEARTH } from '../../../shared/furnaces';
import { RICOCHET_COURT } from '../../../shared/ricochetCourt';
import { GameController } from '../../../src/core/gameController';
import {
  resetWorldExploration,
  setWorldExploration,
  worldFurnaces,
} from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import {
  clearStaticFurnaceArtwork,
  drawFurnacesRelative,
} from '../../../src/rendering/furnaceRenderer';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import {
  clearStaticCourtArtwork,
  drawRicochetCourt,
} from '../../../src/rendering/ricochetCourtRenderer';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
afterEach(() => {
  clearStaticFurnaceArtwork();
  clearStaticCourtArtwork();
  canvasManager.destroy();
  resetWorldExploration();
  vi.restoreAllMocks();
  restoreViewport();
});

function scene(dpr = 1.5) {
  canvasManager.destroy();
  restoreViewport = setWindowViewport(800, 1094, dpr);
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const exploration = new ExplorationMap();
  exploration.reveal(TOWN_HEARTH.position, 800);
  setWorldExploration(exploration.snapshot());
  const ctx = canvasManager.requireContext();
  const surfaces: HTMLCanvasElement[] = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (element instanceof HTMLCanvasElement) {
      surfaces.push(element);
    }
    return element;
  });
  return { ctx, surfaces };
}

function watchCallerState(ctx: CanvasRenderingContext2D) {
  ctx.translate(3, 4);
  ctx.shadowBlur = 7;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#123456';
  const transform = ctx.getTransform();
  const save = ctx.save.bind(ctx),
    restore = ctx.restore.bind(ctx);
  let depth = 0;
  vi.spyOn(ctx, 'save').mockImplementation(() => {
    save();
    depth++;
  });
  vi.spyOn(ctx, 'restore').mockImplementation(() => {
    restore();
    depth--;
  });
  return () => {
    expect(depth).toBe(0);
    expect(ctx.getTransform()).toMatchObject({
      a: transform.a,
      b: transform.b,
      c: transform.c,
      d: transform.d,
      e: transform.e,
      f: transform.f,
    });
    expect(ctx).toMatchObject({ shadowBlur: 7, lineWidth: 3, strokeStyle: '#123456' });
  };
}

test.each(['null', 'throw'])(
  'court allocation %s restores caller state and releases its failed bitmap',
  (mode) => {
    const { ctx, surfaces } = scene();
    const expectCallerState = watchCallerState(ctx);
    const failure = new Error('Court allocation failed');
    const allocation = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    if (mode === 'null') {
      allocation.mockReturnValueOnce(null);
    } else {
      allocation.mockImplementationOnce(() => {
        throw failure;
      });
    }
    expect(() => drawRicochetCourt(RICOCHET_COURT.center)).toThrow(
      mode === 'null' ? 'Court artwork canvas unavailable' : failure
    );
    expectCallerState();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ width: 0, height: 0 });
    drawRicochetCourt(RICOCHET_COURT.center);
    expectCallerState();
    expect(surfaces).toHaveLength(2);
    expect(surfaces[1]?.width).toBeGreaterThan(0);
  }
);

test.each(['court', 'furnace ring', 'furnace bed'])(
  '%s drawImage failure restores caller state and retains reusable artwork',
  (pass) => {
    const { ctx, surfaces } = scene();
    const expectCallerState = watchCallerState(ctx);
    const paint = () =>
      pass === 'court'
        ? drawRicochetCourt(RICOCHET_COURT.center)
        : drawFurnacesRelative(TOWN_HEARTH.position);
    const drawImage = ctx.drawImage.bind(ctx);
    const failure = new Error('Cached artwork blit failed');
    let blits = 0;
    const blit = vi
      .spyOn(ctx, 'drawImage')
      .mockImplementation((...args: Parameters<CanvasRenderingContext2D['drawImage']>) => {
        blits++;
        if (blits === (pass === 'furnace bed' ? 2 : 1)) {
          throw failure;
        }
        Reflect.apply(drawImage, ctx, args);
      });
    expect(paint).toThrow(failure);
    expectCallerState();
    const retained = [...surfaces];
    expect(retained).toHaveLength(pass === 'court' ? 1 : 2);
    expect(retained.every((c) => c.width > 0 && c.height > 0)).toBe(true);
    blit.mockRestore();
    paint();
    expectCallerState();
    expect(surfaces).toEqual(retained);
  }
);

test('warm furnaces reuse two static surfaces while flame geometry and ring opacity stay live', () => {
  const { ctx, surfaces } = scene();
  const blits = vi.spyOn(ctx, 'drawImage');
  const paths: Array<{ points: number[][]; color: string; dashes: number[] }> = [];
  let points: number[][] = [];
  const begin = ctx.beginPath.bind(ctx),
    move = ctx.moveTo.bind(ctx),
    line = ctx.lineTo.bind(ctx),
    stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    points = [];
    begin();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    points.push([x, y]);
    move(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    points.push([x, y]);
    line(x, y);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    paths.push({ points: [...points], color: String(ctx.strokeStyle), dashes: ctx.getLineDash() });
    stroke();
  });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  drawFurnacesRelative(TOWN_HEARTH.position);
  const firstFlames = paths.filter((p) => p.points.length >= 30);
  const firstRing = paths.find((p) => p.dashes.length === 2 && p.points.length === 0);
  expect(firstFlames).toHaveLength(10);
  expect(firstRing).toBeDefined();
  expect(surfaces).toHaveLength(2);
  const firstImages = blits.mock.calls.map((args) => args[0]);
  expect(firstImages).toEqual(surfaces);
  paths.length = 0;
  blits.mockClear();
  clock.mockReturnValue(1000);
  drawFurnacesRelative(TOWN_HEARTH.position);
  expect(surfaces).toHaveLength(2);
  expect(blits.mock.calls.map((args) => args[0])).toEqual(firstImages);
  const laterFlames = paths.filter((p) => p.points.length >= 30);
  expect(laterFlames).toHaveLength(10);
  expect(laterFlames.map((p) => p.points)).not.toEqual(firstFlames.map((p) => p.points));
  expect(paths.find((p) => p.dashes.length === 2 && p.points.length === 0)?.color).not.toBe(
    firstRing?.color
  );
});

test('the shared furnace artwork does not grow with the number of lit world furnaces', () => {
  const { surfaces } = scene();
  const exploration = new ExplorationMap();
  for (const lot of CIVIC_LOTS) {
    worldFurnaces.light(lot.id);
    exploration.reveal(lot.position, 800);
  }
  setWorldExploration(exploration.snapshot());
  for (const lot of CIVIC_LOTS) {
    drawFurnacesRelative(lot.position);
  }
  expect(surfaces).toHaveLength(2);
  expect(surfaces.reduce((sum, c) => sum + c.width * c.height, 0)).toBeLessThanOrEqual(1_000_000);
});

test('court panels reuse one bounded bitmap and labels still paint on every visit', () => {
  const { ctx, surfaces } = scene();
  const blits = vi.spyOn(ctx, 'drawImage'),
    labels = vi.spyOn(ctx, 'fillText');
  drawRicochetCourt(RICOCHET_COURT.center);
  const first = blits.mock.calls[0]?.[0];
  drawRicochetCourt({ ...RICOCHET_COURT.center, x: RICOCHET_COURT.center.x + 0.25 });
  expect(surfaces).toHaveLength(1);
  expect(blits.mock.calls.map((args) => args[0])).toEqual([first, first]);
  expect(labels).toHaveBeenCalledTimes(4);
  expect(surfaces.reduce((sum, c) => sum + c.width * c.height, 0)).toBeLessThanOrEqual(2_000_000);
});

test('Scan easing uses live vectors without building or replacing flight artwork', () => {
  const { ctx, surfaces } = scene();
  drawFurnacesRelative(TOWN_HEARTH.position);
  drawRicochetCourt(RICOCHET_COURT.center);
  const flight = [...surfaces],
    blits = vi.spyOn(ctx, 'drawImage');
  canvasManager.easeZoomToward(0.25, 0);
  for (const now of [16, 32, 64, 128]) {
    canvasManager.easeZoomToward(0.25, now);
    canvasManager.beginWorldLayers(ctx);
    drawFurnacesRelative(TOWN_HEARTH.position);
    drawRicochetCourt(RICOCHET_COURT.center);
    canvasManager.endWorldLayers(ctx);
  }
  expect(surfaces).toEqual(flight);
  expect(blits).not.toHaveBeenCalled();
  canvasManager.easeZoomToward(1, 1128);
  canvasManager.easeZoomToward(1, 2128);
  expect(canvasManager.isFlightView()).toBe(true);
  drawFurnacesRelative(TOWN_HEARTH.position);
  drawRicochetCourt(RICOCHET_COURT.center);
  expect(surfaces).toEqual(flight);
  expect(blits).toHaveBeenCalledTimes(3);
});

test('DPR and quality changes release old surfaces before constructing their replacements', () => {
  const { ctx, surfaces } = scene();
  for (const [dpr, glow] of [
    [1, 'full'],
    [2, 'full'],
    [1.5, 'off'],
    [1.5, 'full'],
  ] satisfies [number, string][]) {
    const previous = [...surfaces];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    configureRenderQuality(`?performance=collect&renderGlow=${glow}`, 'touch');
    drawFurnacesRelative(TOWN_HEARTH.position);
    drawRicochetCourt(RICOCHET_COURT.center);
    expect(previous.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    expect(surfaces.filter((c) => c.width > 0)).toHaveLength(glow === 'full' ? 3 : 2);
    expect(surfaces.reduce((sum, c) => sum + c.width * c.height, 0)).toBeLessThanOrEqual(3_000_000);
  }
});

test('oversized native artwork stays vector-painted instead of lowering resolution or allocating beyond the cap', () => {
  const { ctx, surfaces } = scene();
  ctx.setTransform(10, 0, 0, 10, 0, 0);
  const strokes = vi.spyOn(ctx, 'stroke'),
    blits = vi.spyOn(ctx, 'drawImage');
  drawFurnacesRelative(TOWN_HEARTH.position);
  drawRicochetCourt(RICOCHET_COURT.center);
  expect(surfaces).toHaveLength(0);
  expect(blits).not.toHaveBeenCalled();
  expect(strokes.mock.calls.length).toBeGreaterThan(20);
});

test('starting a fresh flight releases the retained furnace and court backing stores', () => {
  const { surfaces } = scene();
  drawFurnacesRelative(TOWN_HEARTH.position);
  drawRicochetCourt(RICOCHET_COURT.center);
  expect(surfaces).toHaveLength(3);
  GameController.getInstance().newGame('New pilot');
  expect(surfaces.every((c) => c.width === 0 && c.height === 0)).toBe(true);
});

test('detaching the runtime releases retained artwork', () => {
  const { surfaces } = scene();
  drawFurnacesRelative(TOWN_HEARTH.position);
  drawRicochetCourt(RICOCHET_COURT.center);
  expect(surfaces).toHaveLength(3);
  GameController.getInstance().detachRuntime();
  expect(surfaces.every((c) => c.width === 0 && c.height === 0)).toBe(true);
});

test('a failed replacement bed releases both partial surfaces and exposes the failure', () => {
  const { ctx, surfaces } = scene();
  drawFurnacesRelative(TOWN_HEARTH.position);
  const previous = [...surfaces];
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  const getContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: Parameters<HTMLCanvasElement['getContext']>
  ) {
    if (surfaces.indexOf(this) === 3) {
      return null;
    }
    return getContext.apply(this, args);
  });
  expect(() => drawFurnacesRelative(TOWN_HEARTH.position)).toThrow(
    'Furnace bed canvas unavailable'
  );
  expect(surfaces).toHaveLength(4);
  expect(previous.every((c) => c.width === 0 && c.height === 0)).toBe(true);
  expect(surfaces.every((c) => c.width === 0 && c.height === 0)).toBe(true);
});
