import { expect, test, vi } from 'vitest';
import type { LootData } from '../../../shared-types';
import { PALETTE } from '../../../src/constants';
import { LootField } from '../../../src/entities/loot/LootField';
import { drawLootRelative } from '../../../src/entities/loot/lootRenderer';
import { Ship } from '../../../src/entities/ship/Ship';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setWindowViewport } from '../../support/viewport';

test('ordinary loot skips motion queries while newly visible rare salvage follows current preferences', () => {
  const restoreViewport = setWindowViewport(800, 600);
  LootField.getInstance().clear();
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  const ctx = canvasManager.requireContext();
  const ship = new Ship({ position: { x: 0, y: 0 } });
  let reduceMotion = false;
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    Object.assign(new window.EventTarget(), {
      matches: reduceMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    })
  );
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const images = vi.spyOn(ctx, 'drawImage');
  const labels = vi.spyOn(ctx, 'fillText');
  const allocatingProjection = vi.spyOn(canvasManager, 'worldToScreen');
  const outputProjection = vi.spyOn(canvasManager, 'worldToScreenInto');
  const expectReusedProjection = (count: number) => {
    expect(allocatingProjection).not.toHaveBeenCalled();
    expect(outputProjection).toHaveBeenCalledTimes(count);
    expect(new Set(outputProjection.mock.calls.map(([out]) => out)).size).toBe(1);
  };
  const ordinary: LootData[] = [
    { id: 'shard-light', position: { x: -80, y: -30 }, mass: 0, radius: 14, kind: 'shard' },
    { id: 'shard', position: { x: 80, y: -30 }, mass: 0.75, radius: 14, kind: 'shard' },
  ];
  const malformed: LootData = {
    id: 'invalid-equipment-position',
    position: { x: Number.NaN, y: 0 },
    mass: 0,
    radius: 22,
    kind: 'boost_coupling',
  };
  const prominent: LootData[] = [
    { id: 'coupling', position: { x: 0, y: 40 }, mass: 0, radius: 22, kind: 'boost_coupling' },
    { id: 'canister', position: { x: 70, y: 40 }, mass: 0, radius: 22, kind: 'tap' },
  ];
  const clearFrame = () => {
    ctx.fillStyle = PALETTE.BG;
    ctx.fillRect(0, 0, 800, 600);
    images.mockClear();
    labels.mockClear();
    allocatingProjection.mockClear();
    outputProjection.mockClear();
  };
  const pixels = () => Array.from(ctx.getImageData(280, 230, 240, 80).data);
  try {
    clearFrame();
    drawLootRelative(ship, ordinary);
    expectReusedProjection(2);
    const firstFrameProjection = outputProjection.mock.calls[0]?.[0];
    const ordinaryPixels = pixels();
    expect(ordinaryPixels.some((value, index) => index % 4 === 0 && value > 0)).toBe(true);
    expect(images).toHaveBeenCalledTimes(2);
    for (const [index, x] of [320, 480].entries()) {
      const image = images.mock.calls[index]?.[0];
      if (!(image instanceof HTMLCanvasElement)) {
        throw new Error('Ordinary loot did not submit native sprite artwork');
      }
      expect(images.mock.calls[index]).toEqual([
        image,
        x - image.width / 2,
        270 - image.height / 2,
        image.width,
        image.height,
      ]);
    }
    now.mockReturnValue(300);
    reduceMotion = true;
    for (let frame = 0; frame < 8; frame += 1) {
      clearFrame();
      drawLootRelative(ship, [...ordinary, malformed]);
      expectReusedProjection(3);
      expect(outputProjection.mock.calls[0]?.[0]).not.toBe(firstFrameProjection);
      expect(images).toHaveBeenCalledTimes(2);
      expect(labels).not.toHaveBeenCalled();
    }
    expect(pixels()).toEqual(ordinaryPixels);
    expect(media).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(9);

    // Two valid prominent drops share one fresh preference read in this frame.
    clearFrame();
    drawLootRelative(ship, [...ordinary, malformed, ...prominent]);
    expectReusedProjection(5);
    expect(media.mock.calls).toEqual([['(prefers-reduced-motion: reduce)']]);
    expect(labels.mock.calls).toEqual([
      ['BOOST COUPLING', 400, 369],
      ['TAP CANISTER', 470, 369],
    ]);
    expect(images).toHaveBeenCalledTimes(2);

    reduceMotion = false;
    clearFrame();
    drawLootRelative(ship, prominent);
    expect(media).toHaveBeenCalledTimes(2);
    // Fixed clock: 300 ms gives a 1.08 pulse; the two world x values set distinct bob phases.
    expect(labels.mock.calls[0]?.[0]).toBe('BOOST COUPLING');
    expect(labels.mock.calls[0]?.[1]).toBe(400);
    expect(labels.mock.calls[0]?.[2]).toBeCloseTo(340 + Math.sin(2 / 3) * 6 + 23.76 + 7, 10);
    expect(labels.mock.calls[1]?.[0]).toBe('TAP CANISTER');
    expect(labels.mock.calls[1]?.[1]).toBe(470);
    expect(labels.mock.calls[1]?.[2]).toBeCloseTo(340 + Math.sin(2 / 3 + 0.7) * 6 + 23.76 + 7, 10);
    expect(labels.mock.calls[0]?.[2]).not.toBe(labels.mock.calls[1]?.[2]);

    media.mockClear();
    reduceMotion = true;
    clearFrame();
    drawLootRelative(ship, ordinary);
    expect(media).not.toHaveBeenCalled();
    drawLootRelative(ship, prominent);
    expect(media).toHaveBeenCalledOnce();
    expect(labels.mock.calls).toEqual([
      ['BOOST COUPLING', 400, 369],
      ['TAP CANISTER', 470, 369],
    ]);
    expect(now).toHaveBeenCalledTimes(13);

    // A nested draw uses a different output while the outer trace still needs its own.
    const nestedCanvas = document.createElement('canvas');
    nestedCanvas.width = 800;
    nestedCanvas.height = 600;
    const nestedContext = nestedCanvas.getContext('2d');
    if (!nestedContext) {
      throw new Error('Nested loot canvas context unavailable');
    }
    const nestedLabels = vi.spyOn(nestedContext, 'fillText');
    const context = vi.spyOn(canvasManager, 'getContext');
    const stroke = ctx.stroke.bind(ctx);
    vi.spyOn(ctx, 'stroke').mockImplementationOnce(() => {
      context.mockReturnValueOnce(nestedContext);
      drawLootRelative(ship, [
        {
          id: 'nested-equipment',
          position: { x: -200, y: -40 },
          mass: 0,
          radius: 22,
          kind: 'boost_coupling',
        },
      ]);
      stroke();
    });
    clearFrame();
    drawLootRelative(ship, prominent);
    expect(allocatingProjection).not.toHaveBeenCalled();
    expect(outputProjection).toHaveBeenCalledTimes(3);
    const outerProjection = outputProjection.mock.calls[0]?.[0];
    expect(outputProjection.mock.calls[1]?.[0]).not.toBe(outerProjection);
    expect(outputProjection.mock.calls[2]?.[0]).toBe(outerProjection);
    expect(nestedLabels.mock.calls).toEqual([['BOOST COUPLING', 200, 289]]);
    expect(labels.mock.calls).toEqual([
      ['BOOST COUPLING', 400, 369],
      ['TAP CANISTER', 470, 369],
    ]);
  } finally {
    vi.restoreAllMocks();
    LootField.getInstance().clear();
    drawLootRelative(ship, []);
    canvasManager.destroy();
    restoreViewport();
  }
});
