import { afterEach, expect, test, vi } from 'vitest';
import {
  drawRoidInteractionCues,
  reflectiveFacetCueCount,
} from '../../../src/entities/roid/roidRenderer';

type PathCommand =
  | { kind: 'move' | 'line'; x: number; y: number }
  | { kind: 'arc'; args: Parameters<CanvasRenderingContext2D['arc']> }
  | { kind: 'close' };

function paintState(ctx: CanvasRenderingContext2D) {
  const { a, b, c, d, e, f } = ctx.getTransform();
  return {
    transform: [a, b, c, d, e, f],
    color: ctx.strokeStyle,
    width: ctx.lineWidth,
    alpha: ctx.globalAlpha,
    cap: ctx.lineCap,
  };
}

function cueScene() {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Asteroid cue scenario requires a real Canvas context');
  }
  ctx.translate(7, 11);
  ctx.strokeStyle = '#123456';
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 3;
  ctx.lineCap = 'square';
  const before = paintState(ctx);
  let commands: PathCommand[] = [];
  const strokes: Array<{ commands: PathCommand[]; state: ReturnType<typeof paintState> }> = [];
  const beginPath = ctx.beginPath.bind(ctx);
  const moveTo = ctx.moveTo.bind(ctx);
  const lineTo = ctx.lineTo.bind(ctx);
  const arc = ctx.arc.bind(ctx);
  const closePath = ctx.closePath.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  const begin = vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    commands = [];
    beginPath();
  });
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    commands.push({ kind: 'move', x, y });
    moveTo(x, y);
  });
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    commands.push({ kind: 'line', x, y });
    lineTo(x, y);
  });
  vi.spyOn(ctx, 'arc').mockImplementation((...args) => {
    commands.push({ kind: 'arc', args });
    arc(...args);
  });
  vi.spyOn(ctx, 'closePath').mockImplementation(() => {
    commands.push({ kind: 'close' });
    closePath();
  });
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    strokes.push({ commands: [...commands], state: paintState(ctx) });
    Reflect.apply(stroke, ctx, args);
  });
  return { ctx, before, begin, strokes, fill: vi.spyOn(ctx, 'fill') };
}

afterEach(() => vi.restoreAllMocks());

test('reflective cue count grows within a bounded three-facet range', () => {
  expect(reflectiveFacetCueCount(0, 9)).toBe(1);
  expect(reflectiveFacetCueCount(4, 9)).toBe(2);
  expect(reflectiveFacetCueCount(9, 9)).toBe(3);
  expect(reflectiveFacetCueCount(100, 0)).toBe(1);
});

test('a reflective rock gains sparse unfilled facets as its stored energy rises', () => {
  const { ctx, before, strokes, fill } = cueScene();
  const phenomenon = {
    kind: 'reflective',
    clusterId: 'charged-cluster',
    energy: 0,
    maxEnergy: 9,
  } as const;
  for (const [energy, count] of [
    [0, 1],
    [4, 2],
    [9, 3],
  ] as const) {
    strokes.length = 0;
    drawRoidInteractionCues(ctx, { phenomenon: { ...phenomenon, energy } }, 20, 125, 240);
    expect(strokes).toHaveLength(count);
    for (const [index, path] of strokes.entries()) {
      expect(path.commands.map((command) => command.kind)).toEqual(['move', 'line']);
      const [start, end] = path.commands;
      if (start?.kind !== 'move' || end?.kind !== 'line') {
        throw new Error('Reflective facet did not draw one open line segment');
      }
      expect(Math.hypot(start.x, start.y)).toBeCloseTo(4.4);
      expect(Math.hypot(end.x, end.y)).toBeCloseTo(10 + index * 1.2);
      if (index === 1) {
        expect(start.x).toBeCloseTo(4.4);
        expect(start.y).toBe(0);
        expect(end.x).toBeCloseTo(11.2);
        expect(end.y).toBe(0);
      }
      expect(path.state.transform).toEqual([1, 0, 0, 1, 132, 251]);
      expect(path.state.color).toBe('#94a3b8');
      expect(path.state.width).toBeCloseTo(1.1, 6);
      expect(path.state.alpha).toBeCloseTo(0.72, 6);
      expect(path.state.cap).toBe('round');
    }
    expect(paintState(ctx)).toEqual(before);
  }
  expect(fill).not.toHaveBeenCalled();
});

test('rocks without reflection metadata leave the Canvas untouched', () => {
  const { ctx, before, begin, strokes, fill } = cueScene();
  drawRoidInteractionCues(ctx, {}, 20, 125, 240);
  expect(begin).not.toHaveBeenCalled();
  expect(strokes).toEqual([]);
  expect(fill).not.toHaveBeenCalled();
  expect(paintState(ctx)).toEqual(before);
});
