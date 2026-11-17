import { releaseBitmap, resizeBitmap } from './bitmapBudget';

export type RasterSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

/** Reset bitmap and all drawing state exactly as a newly sized canvas. */
export function prepareRasterSurface(
  width: number,
  height: number,
  recycled: RasterSurface | undefined,
  unavailableMessage: string
): RasterSurface | undefined {
  const reusable = recycled?.context.isContextLost?.() ? undefined : recycled;
  if (recycled && !reusable) {
    discardRasterSurface(recycled);
  }
  const canvas = reusable?.canvas ?? document.createElement('canvas');
  try {
    // Even equal dimensions must reset paths, clips, styles and transparent pixels.
    if (!resizeBitmap(canvas, width, height, unavailableMessage, 'cache', true)) {
      return undefined;
    }
    const context = reusable?.context ?? canvas.getContext('2d');
    if (!context) {
      throw new Error(unavailableMessage);
    }
    return reusable ?? { canvas, context };
  } catch (error) {
    // A failed getContext never returns a surface to the caller for disposal.
    releaseBitmap(canvas);
    throw error;
  }
}

/** Drop unused backing storage while the detached handle awaits collection. */
export function discardRasterSurface(surface: RasterSurface): void {
  releaseBitmap(surface.canvas);
}
