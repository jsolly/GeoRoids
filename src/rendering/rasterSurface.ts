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
): RasterSurface {
  const reusable = recycled?.context.isContextLost?.() ? undefined : recycled;
  if (recycled && !reusable) {
    discardRasterSurface(recycled);
  }
  const canvas = reusable?.canvas ?? document.createElement('canvas');
  // Even equal dimensions must reset paths, clips, styles and transparent pixels.
  canvas.width = width;
  canvas.height = height;
  const context = reusable?.context ?? canvas.getContext('2d');
  if (!context) {
    throw new Error(unavailableMessage);
  }
  return reusable ?? { canvas, context };
}

/** Drop unused backing storage while the detached handle awaits collection. */
export function discardRasterSurface(surface: RasterSurface): void {
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}
