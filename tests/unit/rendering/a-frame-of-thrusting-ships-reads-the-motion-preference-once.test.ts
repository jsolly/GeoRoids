import { expect, test, vi } from 'vitest';
import { Ship } from '../../../src/entities/ship/Ship';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawShipLighting } from '../../../src/rendering/shipLighting';
import { setWindowViewport } from '../../support/viewport';

/**
 * `drawShipLighting` draws one engine light per thrusting ship. Querying the
 * reduced-motion preference inside that loop parses the media query and
 * allocates a MediaQueryList for every ship, every frame.
 */
test('a frame of thrusting ships reads the motion preference once and honors it', () => {
  const restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  let reduceMotion = true;
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    Object.assign(new window.EventTarget(), {
      matches: reduceMotion && query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    })
  );
  try {
    const ctx = canvasManager.requireContext();
    const lights = vi.spyOn(ctx, 'ellipse');
    const scale = canvasManager.getPlayfieldScale();
    const ships = [0, 1, 2, 3].map((index) => {
      const ship = new Ship({ position: { x: index * 40 - 60, y: 0 } });
      ship.thrusting = true;
      return ship;
    });

    // Four thrusting ships in one frame share a single preference read.
    drawShipLighting({ x: 0, y: 0 }, ships);
    expect(lights).toHaveBeenCalledTimes(4);
    expect(media.mock.calls).toEqual([['(prefers-reduced-motion: reduce)']]);

    // The shared value actually reaches each light: reduced motion pins the
    // flicker to exactly 1, so the reach is radius * 4 with no oscillation.
    for (const [index, ship] of ships.entries()) {
      expect(lights.mock.calls[index]?.[2]).toBeCloseTo(ship.r * scale * 4, 10);
    }

    // A frame with nothing thrusting asks nothing at all.
    media.mockClear();
    lights.mockClear();
    for (const ship of ships) {
      ship.thrusting = false;
    }
    drawShipLighting({ x: 0, y: 0 }, ships);
    expect(lights).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();

    // The next drawing frame reads the preference afresh rather than caching it
    // across frames, so a pilot changing the system setting is picked up.
    media.mockClear();
    lights.mockClear();
    reduceMotion = false;
    for (const ship of ships) {
      ship.thrusting = true;
    }
    drawShipLighting({ x: 0, y: 0 }, ships);
    expect(media).toHaveBeenCalledOnce();
    expect(lights).toHaveBeenCalledTimes(4);
    // Motion allowed: the flicker oscillates, so the reach leaves radius * 4.
    const first = ships[0];
    if (!first) {
      throw new Error('Missing fixture ship');
    }
    expect(lights.mock.calls[0]?.[2]).not.toBeCloseTo(first.r * scale * 4, 10);
  } finally {
    vi.restoreAllMocks();
    canvasManager.destroy();
    restoreViewport();
  }
});
