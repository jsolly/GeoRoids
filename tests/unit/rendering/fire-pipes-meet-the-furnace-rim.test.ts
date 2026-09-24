import { afterEach, expect, test } from 'vitest';
import { civicLot, pipeHopToParent, TOWN_HEARTH } from '../../../shared/furnaces';
import { noteFurnacePipePulse, resetFurnacePipePulses } from '../../../src/fx/furnacePipePulse';
import { worldFurnaces } from '../../../src/network/worldExploration';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawFurnacePipes } from '../../../src/rendering/furnaceRenderer';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
let canvas: HTMLCanvasElement | undefined;
let previousCanvas: HTMLElement | null = null;

afterEach(() => {
  canvasManager.destroy();
  if (previousCanvas) {
    canvas?.replaceWith(previousCanvas);
  } else {
    canvas?.remove();
  }
  worldFurnaces.replaceLit([]);
  resetFurnacePipePulses();
  restoreViewport();
});

test.each([false, true])(
  'fire pipes leave the furnace interior clear with delivery pulse %s',
  (pulsing) => {
    canvasManager.destroy();
    canvas = document.createElement('canvas');
    canvas.id = 'gameCanvas';
    previousCanvas = document.querySelector('#gameCanvas');
    if (previousCanvas) {
      previousCanvas.replaceWith(canvas);
    } else {
      document.body.append(canvas);
    }
    restoreViewport = setWindowViewport(1280, 900);
    canvasManager.initialize();
    const lot = civicLot('street-1-0');
    if (!lot) {
      throw new Error('Missing furnace');
    }
    worldFurnaces.light(lot.id);
    if (pulsing) {
      expect(noteFurnacePipePulse(lot.id, 0)).toBe(true);
    }
    const ctx = canvasManager.requireContext();
    const hop = pipeHopToParent(lot.id);
    for (const endpoint of [
      { site: lot, neighbor: hop[1] },
      { site: TOWN_HEARTH, neighbor: hop.at(-2) },
    ]) {
      if (!endpoint.neighbor) {
        throw new Error('Missing pipe endpoint');
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawFurnacePipes(endpoint.site.position, 0);
      const center = canvasManager.worldToScreenInto(
        { x: 0, y: 0 },
        endpoint.site.position,
        endpoint.site.position
      );
      const radius = endpoint.site.radius * canvasManager.getPlayfieldScale();
      const pixels = ctx.getImageData(
        Math.round(center.x - radius * 0.7),
        Math.round(center.y - radius * 0.7),
        Math.floor(radius * 1.4),
        Math.floor(radius * 1.4)
      ).data;
      expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(false);
      const angle = Math.atan2(
        endpoint.neighbor.y - endpoint.site.position.y,
        endpoint.neighbor.x - endpoint.site.position.x
      );
      const outside = ctx.getImageData(
        Math.round(center.x + Math.cos(angle) * (radius + 8)) - 3,
        Math.round(center.y + Math.sin(angle) * (radius + 8)) - 3,
        7,
        7
      ).data;
      expect(outside.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    }
  }
);
