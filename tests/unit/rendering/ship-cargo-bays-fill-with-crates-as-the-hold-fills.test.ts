import { afterEach, expect, test, vi } from 'vitest';
import { PALETTE } from '../../../src/constants';
import { drawCargoHoldArtwork } from '../../../src/rendering/cargoHoldRenderer';
import { hexToRgba } from '../../../src/utils/colorUtils';

afterEach(() => vi.restoreAllMocks());

for (const bay of [
  { kitId: 'scout' as const, cells: 4, x: -40, width: 30, height: 60, crateWidth: 14 },
  { kitId: 'hauler' as const, cells: 12, x: -60, width: 40, height: 52, crateWidth: 9.1 },
]) {
  test(`${bay.kitId} cargo bay stays visible when empty, fills with crates, and marks a full hold`, () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas unavailable');
    }
    const rectangles: { color: string | CanvasGradient | CanvasPattern; width: number }[] = [];
    const rects = vi.spyOn(ctx, 'fillRect').mockImplementation((_x, _y, width) => {
      rectangles.push({ color: ctx.fillStyle, width });
    });
    const border = vi.spyOn(ctx, 'strokeRect');
    const labels = vi.spyOn(ctx, 'fillText');
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, 0.9);
    const partialColor = ctx.fillStyle;
    ctx.fillStyle = hexToRgba(PALETTE.LOOT, 0.8);
    const fullColor = ctx.fillStyle;
    for (const fraction of [0, 0.375, 1]) {
      rectangles.length = 0;
      rects.mockClear();
      border.mockClear();
      labels.mockClear();
      drawCargoHoldArtwork(ctx, {
        position: { x: 200, y: 300 },
        radius: 100,
        angle: Math.PI / 3,
        kitId: bay.kitId,
        color: '#00ffff',
        fraction,
        now: 0,
      });
      expect(border).toHaveBeenCalledWith(bay.x, -bay.height / 2, bay.width, bay.height);
      const crates = rectangles.filter(
        (rect) => rect.color === (fraction === 1 ? fullColor : partialColor)
      );
      expect(crates).toHaveLength(
        fraction === 0 ? 0 : fraction === 1 ? bay.cells : bay.cells * 0.375 + 0.5
      );
      if (fraction === 0.375) {
        expect(crates.at(-1)?.width).toBeCloseTo(bay.crateWidth / 2);
      }
      expect(labels.mock.calls.map(([text]) => text)).toEqual(fraction === 1 ? ['CARGO FULL'] : []);
    }
  });
}
