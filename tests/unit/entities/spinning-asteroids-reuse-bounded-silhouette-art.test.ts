import { afterEach, expect, test, vi } from 'vitest';
import * as materialArt from '../../../src/entities/roid/materialArt';
import { Roid } from '../../../src/entities/roid/Roid';
import { clearAsteroidShatters, drawRoidsRelative } from '../../../src/entities/roid/roidRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { configureRenderQuality } from '../../../src/rendering/renderQuality';
import * as vectorJuice from '../../../src/rendering/vectorJuice';

afterEach(() => {
  clearAsteroidShatters();
  configureRenderQuality('', false);
  vi.restoreAllMocks();
});

function scene(dpr = 1) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas unavailable');
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getCanvas').mockReturnValue(canvas);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 500, height: 500 });
  const scale = vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(canvasManager, 'worldToScreenInto').mockImplementation((out, world) =>
    Object.assign(out, { x: 250 + world.x, y: 250 + world.y })
  );
  const images = vi.spyOn(ctx, 'drawImage');
  const ship = new Ship({ position: { x: 0, y: 0 } });
  return {
    ctx,
    scale,
    images,
    draw(roid: Roid): HTMLCanvasElement {
      drawRoidsRelative(ship, [roid]);
      const image = images.mock.lastCall?.[0];
      if (!(image instanceof HTMLCanvasElement)) {
        throw new Error('Expected cached asteroid art');
      }
      return image;
    },
    drawVector(roid: Roid) {
      drawRoidsRelative(ship, [roid]);
    },
    drawBatch(roids: Roid[]) {
      images.mockClear();
      drawRoidsRelative(ship, roids);
      return images.mock.calls.map(([image]) => {
        if (!(image instanceof HTMLCanvasElement)) {
          throw new Error('Expected cached asteroid art');
        }
        return image;
      });
    },
  };
}

function asteroid(id: string, radius = 30): Roid {
  const roid = new Roid({ x: 0, y: 0 }, radius, id);
  roid.angle = 0;
  roid.vertices = 4;
  roid.offsets = [1, 0.8, 1.1, 0.9];
  return roid;
}

test('moving and spinning snapshots reuse numeric geometry while damage marks update and surveyed rocks stay unlabeled', () => {
  const view = scene();
  const detail = vi.spyOn(materialArt, 'drawAsteroidMaterialDetails');
  const captions: string[] = [];
  const watchCaptions = (ctx: CanvasRenderingContext2D): void => {
    if (vi.isMockFunction(ctx.fillText)) {
      return;
    }
    const fill = ctx.fillText.bind(ctx);
    vi.spyOn(ctx, 'fillText').mockImplementation((text, x, y, maxWidth) => {
      captions.push(String(text));
      fill(text, x, y, maxWidth);
    });
  };
  watchCaptions(view.ctx);
  const getContext = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: Parameters<HTMLCanvasElement['getContext']>
  ) {
    const ctx = getContext.apply(this, args);
    if (args[0] === '2d' && ctx && 'fillText' in ctx) {
      watchCaptions(ctx);
    }
    return ctx;
  });
  const turn = vi.spyOn(view.ctx, 'rotate');
  const placement = vi.spyOn(view.ctx, 'translate');
  const roid = asteroid('surveyed-metal');
  roid.material = 'metal';
  roid.ore = 'metal';
  roid.surveyedBy = ['pilot'];
  roid.maxHealth = 100;
  roid.health = 100;
  const image = view.draw(roid);

  roid.position = { x: 12, y: -8 };
  roid.angle = 0.7;
  roid.offsets = [...roid.offsets];
  roid.health = 40;
  expect(view.draw(roid)).toBe(image);
  expect(placement).toHaveBeenCalledWith(262, 242);
  expect(turn).toHaveBeenCalledWith(0.7);
  expect(detail.mock.calls.map((call) => call[6])).toEqual([1, 0.4]);
  expect(captions).toEqual([]);

  const replacement = asteroid(roid.id);
  replacement.material = 'metal';
  expect(view.draw(replacement)).toBe(image);
  replacement.offsets[1] = 0.6;
  const reshaped = view.draw(replacement);
  expect(reshaped).not.toBe(image);
  replacement.r = 50;
  const resized = view.draw(replacement);
  expect(resized).not.toBe(reshaped);
  delete replacement.material;
  expect(view.draw(replacement)).not.toBe(resized);

  const barren = asteroid('surveyed-barren', 40);
  delete barren.material;
  barren.ore = null;
  barren.surveyedBy = ['pilot'];
  view.draw(barren);
  expect(captions).toEqual([]);
});

test('DPR, playfield scale and glow changes regenerate full-resolution asteroid artwork', () => {
  const view = scene();
  const roid = asteroid('resized-display');
  const initial = view.draw(roid);
  view.ctx.setTransform(2, 0, 0, 2, 0, 0);
  const retina = view.draw(roid);
  expect(retina).not.toBe(initial);
  expect(retina.width).toBeGreaterThan(initial.width);
  expect(view.images.mock.lastCall?.slice(1)).toEqual([
    -retina.width / 4,
    -retina.height / 4,
    retina.width / 2,
    retina.height / 2,
  ]);
  view.scale.mockReturnValue(1.5);
  const zoomed = view.draw(roid);
  expect(zoomed).not.toBe(retina);
  expect(zoomed.width).toBeGreaterThan(retina.width);
  configureRenderQuality('?performance=collect&renderGlow=off', false);
  const unblurred = view.draw(roid);
  expect(unblurred).not.toBe(zoomed);
  expect(unblurred.width).toBeLessThan(zoomed.width);
});

test('travel through more than 128 asteroid IDs evicts old silhouettes', () => {
  const view = scene();
  const first = asteroid('first');
  const initial = view.draw(first);
  for (let index = 0; index < 128; index++) {
    view.draw(asteroid(`passing-${index}`));
  }
  expect(view.draw(first)).not.toBe(initial);
});

test.each([
  { name: '129 ordinary rocks', count: 129, radius: 30, dpr: 1 },
  { name: 'colossal rocks above the pixel budget', count: 12, radius: 120, dpr: 4 },
])('a stable view of $name reuses admitted artwork across frames', ({ count, radius, dpr }) => {
  const view = scene(dpr);
  const rocks = Array.from({ length: count }, (_, index) => asteroid(`visible-${index}`, radius));
  const initial = view.drawBatch(rocks);
  expect(initial.length).toBeGreaterThan(0);
  expect(initial.length).toBeLessThan(count);
  expect(initial.length).toBeLessThanOrEqual(128);
  expect(
    initial.reduce((pixels, image) => pixels + image.width * image.height, 0)
  ).toBeLessThanOrEqual(8_000_000);
  const silhouette = vi.spyOn(vectorJuice, 'strokePhosphorPolyline');
  for (let frame = 0; frame < 3; frame++) {
    silhouette.mockClear();
    for (const rock of rocks) {
      rock.angle += 0.1;
      rock.offsets = [...rock.offsets];
    }
    const reused = view.drawBatch(rocks);
    expect(reused).toHaveLength(initial.length);
    expect(reused.every((image, index) => image === initial[index])).toBe(true);
    expect(silhouette).toHaveBeenCalledTimes((count - initial.length) * (radius >= 40 ? 2 : 1));
    expect(silhouette.mock.calls.every(([ctx]) => ctx === view.ctx)).toBe(true);
  }
});

test('colossal rocks respect the total pixel budget and oversized art stays full-size vector', () => {
  const view = scene(4);
  const first = asteroid('first-colossal', 120);
  const initial = view.draw(first);
  let allocated = initial.width * initial.height;
  for (let index = 0; allocated <= 8_000_000; index++) {
    const image = view.draw(asteroid(`colossal-${index}`, 120));
    allocated += image.width * image.height;
  }
  expect(view.draw(first)).not.toBe(initial);

  const silhouette = vi.spyOn(vectorJuice, 'strokePhosphorPolyline');
  view.images.mockClear();
  const oversized = asteroid('oversized', 1000);
  view.drawVector(oversized);
  expect(view.images).not.toHaveBeenCalled();
  expect(silhouette).toHaveBeenCalledTimes(2);
  expect(silhouette.mock.calls[0]?.[1][0]).toEqual({ x: 1250, y: 250 });
});
