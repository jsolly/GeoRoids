type TracePoint = { x: number; y: number };

/** Diagnostic rerenders only: sampling may flush Canvas, so callers must compare
 * the final traced bitmap with their original, uninstrumented frozen capture. */
export function traceNativePaint(
  context: CanvasRenderingContext2D,
  points: readonly TracePoint[],
  capturePixels: (observation: CanvasRenderingContext2D, width: number) => ImageData
) {
  if (points.length === 0 || points.length > 4) {
    throw new Error('Native paint trace requires one to four backing-pixel witnesses');
  }
  const canvas = document.createElement('canvas');
  canvas.width = points.length;
  canvas.height = 1;
  const observation = canvas.getContext('2d', { willReadFrequently: true });
  if (!observation) {
    throw new Error('Native paint trace observation canvas unavailable');
  }
  const sample = () => {
    for (const [index, point] of points.entries()) {
      observation.drawImage(context.canvas, point.x, point.y, 1, 1, index, 0, 1, 1);
    }
    const pixels = capturePixels(observation, points.length);
    return Array.from(pixels.data);
  };
  const state = () => {
    const matrix = context.getTransform();
    return {
      matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
      fill: String(context.fillStyle),
      stroke: String(context.strokeStyle),
      width: context.lineWidth,
      cap: context.lineCap,
      join: context.lineJoin,
      alpha: context.globalAlpha,
      composite: context.globalCompositeOperation,
      shadow: [
        context.shadowColor,
        context.shadowBlur,
        context.shadowOffsetX,
        context.shadowOffsetY,
      ],
      filter: context.filter,
      smoothing: context.imageSmoothingEnabled,
    };
  };
  const methods = ['stroke', 'fill', 'fillRect', 'drawImage'] as const;
  const originals = methods.map((method) => ({ method, original: context[method] }));
  const changes: {
    operation: number;
    method: (typeof methods)[number];
    caller: string;
    source: string | null;
    before: ReturnType<typeof state>;
    after: ReturnType<typeof state>;
    pixelsBefore: number[];
    pixelsAfter: number[];
  }[] = [];
  let pixels = sample();
  let operations = 0;
  for (const { method, original } of originals) {
    Reflect.set(
      context,
      method,
      new Proxy(original, {
        apply(target, receiver, argumentsList) {
          operations++;
          if (operations > 4096) {
            throw new Error('Native paint trace exceeded its bounded draw budget');
          }
          const before = state();
          const result: unknown = Reflect.apply(target, receiver, argumentsList);
          const next = sample();
          if (next.some((channel, index) => channel !== pixels[index])) {
            if (changes.length >= 256) {
              throw new Error('Native paint trace exceeded its bounded pixel-change budget');
            }
            const source: unknown = argumentsList[0];
            changes.push({
              operation: operations,
              method,
              caller:
                (new Error().stack ?? '')
                  .split('\n')
                  .find((line) => line.includes('/src/'))
                  ?.trim() ?? 'unknown',
              source:
                method === 'drawImage' && source instanceof HTMLCanvasElement
                  ? source.id || 'detached-canvas'
                  : null,
              before,
              after: state(),
              pixelsBefore: pixels,
              pixelsAfter: next,
            });
          }
          pixels = next;
          return result;
        },
      })
    );
  }
  return {
    finish() {
      for (const { method, original } of originals) {
        Reflect.set(context, method, original);
      }
      return { points, operations, changes, finalState: state(), pixels };
    },
  };
}
