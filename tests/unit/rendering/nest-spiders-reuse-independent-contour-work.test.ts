import { afterEach, expect, test, vi } from 'vitest';
import type { Position, TerrainSpider } from '../../../shared-types';
import * as score from '../../../src/audio/spiderScore';
import type { ContourLevel } from '../../../src/physics/terrain/contours';
import { setSpiderField } from '../../../src/physics/terrain/spiderSession';
import * as terrain from '../../../src/physics/terrain/terrainSession';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import * as feet from '../../../src/rendering/spiderFootContacts';
import { drawTerrainSpiders } from '../../../src/rendering/spiderRenderer';
import { TestPath2D } from '../../support/TestPath2D';

const work = vi.hoisted(() => ({ queries: 0 }));
vi.mock('../../../src/rendering/contourSpatialIndex', async (original) => {
  const actual = await original<typeof import('../../../src/rendering/contourSpatialIndex')>();
  return {
    ...actual,
    createContourQuery() {
      const query = actual.createContourQuery();
      const previous = new Map<number, ReturnType<typeof query>>();
      return (...args: Parameters<typeof query>) => {
        const result = query(...args);
        if (result !== previous.get(args[1])) {
          work.queries++;
          previous.set(args[1], result);
        }
        return result;
      };
    },
  };
});

afterEach(() => {
  setSpiderField(undefined);
  drawTerrainSpiders({ x: 0, y: 0 }, 'pilot', false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Circle = Position & { radius: number };
type Transform = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;
type PaintEvent =
  | { kind: 'save'; scope: number }
  | { kind: 'restore'; scope: number }
  | { kind: 'clip'; scope: number; circle: Circle }
  | {
      kind: 'path';
      scope: number;
      path: TestPath2D;
      ink: string | CanvasGradient | CanvasPattern;
      clips: Circle[];
    }
  | { kind: 'body'; scope: number; origin: Position; clips: Circle[] }
  | {
      kind: 'leg';
      scope: number;
      root: Position;
      knee: Position;
      toe: Position;
      transform: Transform;
    };
type ControlledDefect = 'none' | 'no-clip' | 'regroup-paths' | 'frozen-toes';

function scene() {
  vi.stubGlobal('Path2D', TestPath2D);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Missing spider test canvas');
  }
  const dpr = 1.5;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vi.spyOn(canvasManager, 'getContext').mockReturnValue(ctx);
  vi.spyOn(canvasManager, 'getViewportSize').mockReturnValue({ width: 1600, height: 800 });
  vi.spyOn(canvasManager, 'getPlayfieldScale').mockReturnValue(1);
  vi.spyOn(score, 'updateSpiderScore').mockImplementation(() => {});
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const levels: ContourLevel[] = [
    {
      index: 0,
      height: 0,
      segments: [
        { ax: -1200, ay: -60, bx: 1200, by: -60 },
        { ax: -1200, ay: 60, bx: 1200, by: 60 },
      ],
    },
  ];
  const terrainQuery = vi.spyOn(terrain, 'getTerrainContours').mockReturnValue(levels);
  // Each body lies inside the other 280-radius infestation disc, while their query rectangles differ.
  const spiders: TerrainSpider[] = [-200, 0].map((x, index) => ({
    id: `guard-${index}`,
    position: { x, y: 0 },
    angle: 0,
    health: 75,
    maxHealth: 75,
    phase: 'scuttling',
    targetId: null,
  }));
  const events: PaintEvent[] = [];
  const scopes: Array<{ id: number; clips: Circle[] }> = [{ id: 0, clips: [] }];
  let nextScope = 0;
  let defect: ControlledDefect = 'none';
  let circle: Circle | undefined;
  let line: Position[] = [];
  const deferredPaths: PaintEvent[] = [];
  const scope = () => {
    const current = scopes.at(-1);
    if (!current) {
      throw new Error('Canvas restore underflow');
    }
    return current;
  };
  const transform = (): Transform => {
    const { a, b, c, d, e, f } = ctx.getTransform();
    return { a, b, c, d, e, f };
  };
  const worldPoint = (x: number, y: number): Position => {
    const m = transform();
    // Invert only the independently fixed DPR and camera projection. Body rotation
    // and variant scale must come from the actual Canvas command transform.
    return { x: (m.a * x + m.c * y + m.e) / dpr - 800, y: (m.b * x + m.d * y + m.f) / dpr - 400 };
  };
  const nativeSave = ctx.save.bind(ctx);
  vi.spyOn(ctx, 'save').mockImplementation(() => {
    nativeSave();
    const current = { id: ++nextScope, clips: [...scope().clips] };
    scopes.push(current);
    events.push({ kind: 'save', scope: current.id });
  });
  const nativeRestore = ctx.restore.bind(ctx);
  vi.spyOn(ctx, 'restore').mockImplementation(() => {
    const current = scope();
    nativeRestore();
    scopes.pop();
    events.push({ kind: 'restore', scope: current.id });
  });
  const nativeBegin = ctx.beginPath.bind(ctx);
  vi.spyOn(ctx, 'beginPath').mockImplementation(() => {
    line = [];
    circle = undefined;
    nativeBegin();
  });
  const nativeArc = ctx.arc.bind(ctx);
  vi.spyOn(ctx, 'arc').mockImplementation((...args) => {
    const [x, y, radius] = args;
    circle = {
      ...worldPoint(x, y),
      radius: (radius * Math.hypot(transform().a, transform().b)) / dpr,
    };
    Reflect.apply(nativeArc, ctx, args);
  });
  const nativeClip = ctx.clip.bind(ctx);
  vi.spyOn(ctx, 'clip').mockImplementation(
    (...args: [] | [CanvasFillRule | undefined] | [Path2D, (CanvasFillRule | undefined)?]) => {
      // Controlled defect affects the real clip boundary, not production source.
      if (defect === 'no-clip') {
        return;
      }
      if (!circle) {
        throw new Error('Expected a circular infestation clip');
      }
      Reflect.apply(nativeClip, ctx, args);
      scope().clips.push(circle);
      events.push({ kind: 'clip', scope: scope().id, circle });
    }
  );
  const nativeMove = ctx.moveTo.bind(ctx);
  vi.spyOn(ctx, 'moveTo').mockImplementation((x, y) => {
    line = [worldPoint(x, y)];
    nativeMove(x, y);
  });
  const nativeLine = ctx.lineTo.bind(ctx);
  vi.spyOn(ctx, 'lineTo').mockImplementation((x, y) => {
    line.push(worldPoint(x, y));
    nativeLine(x, y);
  });
  const nativeStroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'stroke').mockImplementation((...args: [] | [Path2D]) => {
    if (args[0] instanceof TestPath2D) {
      const event: PaintEvent = {
        kind: 'path',
        scope: scope().id,
        path: args[0],
        ink: ctx.strokeStyle,
        clips: [...scope().clips],
      };
      // TestPath2D submissions are recorded at this boundary. This controlled
      // queue models a painter that regroups retained strokes after all bodies.
      (defect === 'regroup-paths' ? deferredPaths : events).push(event);
    } else {
      if (ctx.strokeStyle === '#170d19') {
        const [root, knee, toe] = line;
        if (!root || !knee || !toe || line.length !== 3) {
          throw new Error('A leg must contain root, knee, then actual toe');
        }
        events.push({ kind: 'leg', scope: scope().id, root, knee, toe, transform: transform() });
      }
      Reflect.apply(nativeStroke, ctx, args);
    }
  });
  const nativeEllipse = ctx.ellipse.bind(ctx);
  vi.spyOn(ctx, 'ellipse').mockImplementation((...args) => {
    if (args[0] < 0) {
      events.push({
        kind: 'body',
        scope: scope().id,
        origin: worldPoint(0, 0),
        clips: [...scope().clips],
      });
    }
    Reflect.apply(nativeEllipse, ctx, args);
  });
  const nativeFeet = feet.spiderFootContacts;
  const firstContacts: Position[][] = [];
  let footOrdinal = 0;
  vi.spyOn(feet, 'spiderFootContacts').mockImplementation((...args) => {
    const actual = nativeFeet(...args);
    const ordinal = footOrdinal++;
    const initial = firstContacts[ordinal];
    if (!initial) {
      firstContacts[ordinal] = structuredClone(actual);
    }
    // Keep knees and all draw transforms live while freezing the returned world
    // contacts. Only asserting lineTo changes would miss this controlled defect.
    return defect === 'frozen-toes' && initial ? initial : actual;
  });
  const pathMoves = vi.spyOn(TestPath2D.prototype, 'moveTo');
  return {
    spiders,
    levels,
    terrainQuery,
    clock,
    move() {
      for (const spider of spiders) {
        spider.position.x += 1;
        spider.position.y += 1;
        spider.angle = Math.PI / 2;
      }
      clock.mockReturnValue(125);
    },
    draw(controlledDefect: ControlledDefect = 'none') {
      defect = controlledDefect;
      work.queries = 0;
      footOrdinal = 0;
      events.length = 0;
      deferredPaths.length = 0;
      pathMoves.mockClear();
      setSpiderField({ spiders, nests: [] });
      drawTerrainSpiders({ x: 0, y: 0 }, 'pilot', false);
      events.push(...deferredPaths);
      return {
        queries: work.queries,
        pathMoves: pathMoves.mock.calls.length,
        events: [...events],
        paths: events.filter((event) => event.kind === 'path'),
        legs: events.filter((event) => event.kind === 'leg'),
        finalTransform: transform(),
        depth: scopes.length,
      };
    },
  };
}

type Frame = ReturnType<ReturnType<typeof scene>['draw']>;

function expectClipLifetime(frame: Frame, spiders: readonly TerrainSpider[]) {
  expect(frame.paths).toHaveLength(spiders.length);
  for (const [ordinal, path] of frame.paths.entries()) {
    const spider = spiders[ordinal];
    if (!spider) {
      throw new Error('Missing clipped guard');
    }
    const save = frame.events.findIndex(
      (event) => event.kind === 'save' && event.scope === path.scope
    );
    const clip = frame.events.findIndex(
      (event) => event.kind === 'clip' && event.scope === path.scope
    );
    const stroke = frame.events.indexOf(path);
    const restore = frame.events.findIndex(
      (event) => event.kind === 'restore' && event.scope === path.scope
    );
    const body = frame.events.findIndex(
      (event) => event.kind === 'body' && event.origin.x === spider.position.x
    );
    expect(
      save >= 0 && save < clip && clip < stroke && stroke < restore && restore < body,
      'actual clip installed before retained path and restored before body'
    ).toBe(true);
    expect(path.clips, 'retained stroke uses the current moved circle').toEqual([
      { ...spider.position, radius: 280 },
    ]);
    const clipEvent = frame.events[clip];
    expect(clipEvent).toEqual({ kind: 'clip', scope: path.scope, circle: path.clips[0] });
  }
  expect(
    frame.events.filter((event) => event.kind === 'body').map((event) => event.clips),
    'restoring the infestation scope removes its clip from body drawing'
  ).toEqual([[], []]);
  expect(frame.depth).toBe(1);
  expect(frame.finalTransform).toEqual({ a: 1.5, b: 0, c: 0, d: 1.5, e: 0, f: 0 });
}

function expectPaintOrder(frame: Frame, spiders: readonly TerrainSpider[]) {
  const sequence = frame.events.filter((event) => event.kind === 'path' || event.kind === 'body');
  expect(
    sequence.map((event) => event.kind),
    'overlapping guards keep path and body interleaving'
  ).toEqual(['path', 'body', 'path', 'body']);
  expect(sequence.filter((event) => event.kind === 'body').map((event) => event.origin)).toEqual(
    spiders.map((spider) => spider.position)
  );
  // Legs belong between that guard's retained path and abdomen, not a later batch.
  let cursor = 0;
  for (const event of frame.events) {
    if (event.kind === 'path') {
      expect(cursor % 10).toBe(0);
      cursor++;
    } else if (event.kind === 'leg') {
      expect(cursor % 10).toBeGreaterThanOrEqual(1);
      expect(cursor % 10).toBeLessThanOrEqual(8);
      cursor++;
    } else if (event.kind === 'body') {
      expect(cursor % 10).toBe(9);
      cursor++;
    }
  }
  expect(cursor).toBe(20);
}

function expectLiveToes(frame: Frame, spiders: readonly TerrainSpider[], rotated: boolean) {
  expect(frame.legs).toHaveLength(16);
  for (const [ordinal, spider] of spiders.entries()) {
    const legs = frame.legs.slice(ordinal * 8, ordinal * 8 + 8);
    // Fixed IDs independently imply reaches 0.85 and 0.89. On these two long
    // horizontal lines, projection fixes y and leaves the desired x unchanged.
    const reach = ordinal === 0 ? 0.85 : 0.89;
    const expectedRows = rotated
      ? [60, 60, -60, -60, 60, 60, -60, -60]
      : [-60, -60, -60, -60, 60, 60, 60, 60];
    for (const [foot, leg] of legs.entries()) {
      expect(
        leg.toe.y,
        'actual toe contour membership changes, independently of knee motion'
      ).toBeCloseTo(expectedRows[foot] ?? NaN, 10);
      const side = foot < 4 ? -1 : 1;
      const gait = Math.sin((rotated ? 1 : 0) + (foot % 4) * Math.PI + side) * 9;
      const x = rotated
        ? spider.position.x - side * (48 + Math.abs(gait)) * reach
        : spider.position.x + ((1.5 - (foot % 4)) * 30 + gait) * reach;
      expect(
        leg.toe.x,
        'actual toe endpoint is projected through the live body transform'
      ).toBeCloseTo(x, 10);
      expect(leg.toe.x).toBeGreaterThanOrEqual(-1200);
      expect(leg.toe.x).toBeLessThanOrEqual(1200);
      expect(leg.knee).not.toEqual(leg.toe);
    }
  }
}

test('overlapping nest guards retain queries and paths while actual clips, body order and terrain toes stay live', () => {
  const view = scene();
  const [left, right] = view.spiders;
  if (!left || !right) {
    throw new Error('Missing overlapping guards');
  }
  expect(
    Math.hypot(left.position.x - right.position.x, left.position.y - right.position.y)
  ).toBeLessThan(280);
  const first = view.draw();
  expect(first.queries).toBe(4);
  expect(first.pathMoves).toBe(4);
  expectClipLifetime(first, view.spiders);
  expectPaintOrder(first, view.spiders);
  expectLiveToes(first, view.spiders, false);
  const repeated = view.draw();
  expect(repeated.queries).toBe(0);
  expect(repeated.pathMoves).toBe(0);
  expect(repeated.paths.map(({ path }) => path)).toEqual(first.paths.map(({ path }) => path));
  expect(
    repeated.legs.map(({ root, knee, toe, transform }) => ({ root, knee, toe, transform }))
  ).toEqual(first.legs.map(({ root, knee, toe, transform }) => ({ root, knee, toe, transform })));
  expectClipLifetime(repeated, view.spiders);
  expectPaintOrder(repeated, view.spiders);
  expectLiveToes(repeated, view.spiders, false);
  for (const { path } of first.paths) {
    expect(path.commands).toEqual(
      view.levels.flatMap(({ segments }) =>
        segments.flatMap((s) => [
          { kind: 'moveTo', x: s.ax, y: s.ay },
          { kind: 'lineTo', x: s.bx, y: s.by },
        ])
      )
    );
  }
  view.move();
  const moved = view.draw();
  expect(moved.queries).toBe(0);
  expect(moved.pathMoves).toBe(0);
  expect(moved.paths.map(({ path }) => path)).toEqual(first.paths.map(({ path }) => path));
  expect(moved.paths.map(({ ink }) => ink)).not.toEqual(first.paths.map(({ ink }) => ink));
  expectClipLifetime(moved, view.spiders);
  expectPaintOrder(moved, view.spiders);
  expectLiveToes(moved, view.spiders, true);
  expect(first.legs[0]?.toe.y).toBeCloseTo(-60, 10);
  expect(moved.legs[0]?.toe.y).toBeCloseTo(60, 10);
});

test.each([
  {
    defect: 'no-clip' as const,
    message: /actual clip installed before retained path/u,
    verify: expectClipLifetime,
  },
  {
    defect: 'regroup-paths' as const,
    message: /path and body interleaving/u,
    verify: expectPaintOrder,
  },
  {
    defect: 'frozen-toes' as const,
    message: /actual toe contour membership/u,
    verify: expectLiveToes,
  },
])(
  'controlled $defect defect is rejected by its drawing assertion',
  ({ defect, message, verify }) => {
    const view = scene();
    const baseline = view.draw();
    expectClipLifetime(baseline, view.spiders);
    expectPaintOrder(baseline, view.spiders);
    expectLiveToes(baseline, view.spiders, false);
    view.move();
    const broken = view.draw(defect);
    expect(broken.queries).toBe(0);
    expect(broken.pathMoves).toBe(0);
    expect(() => verify(broken, view.spiders, true)).toThrow(message);
  }
);

test('terrain replacement and despawn invalidate retained spider paths', () => {
  const view = scene();
  const original = view.draw();
  view.terrainQuery.mockReturnValue([
    { index: 0, height: 0, segments: [{ ax: -1200, ay: 70, bx: 1200, by: 70 }] },
  ]);
  const replacement = view.draw();
  expect(replacement.queries).toBe(4);
  expect(replacement.pathMoves).toBe(2);
  expect(
    replacement.paths.every(({ path }) => !original.paths.some((old) => old.path === path))
  ).toBe(true);
  const removed = view.spiders.splice(0, 1);
  view.draw();
  view.spiders.push(...removed);
  const returned = view.draw();
  expect(returned.queries).toBe(2);
  expect(returned.pathMoves).toBe(1);
});

test('crossing contour cells changes only that guard path and a replacement snapshot retains the other guard', () => {
  const view = scene();
  const segments = [-500, 500].flatMap((x) =>
    [-60, 60].map((y) => ({
      ax: x - 120,
      ay: y,
      bx: x + 150,
      by: y,
    }))
  );
  view.terrainQuery.mockReturnValue([{ index: 0, height: 0, segments }]);
  const first = view.draw();
  const guard = view.spiders[0];
  if (!guard) {
    throw new Error('Missing moving guard');
  }
  guard.position.x = 112;
  // Network snapshots replace objects, while cache ownership follows stable IDs.
  view.spiders.splice(0, view.spiders.length, ...structuredClone(view.spiders));
  const crossed = view.draw();
  expect(crossed.queries).toBe(2);
  expect(crossed.pathMoves).toBe(2);
  expect(crossed.paths[0]?.path).not.toBe(first.paths[0]?.path);
  expect(crossed.paths[1]?.path).toBe(first.paths[1]?.path);
  expect(crossed.paths[0]?.path.commands).toEqual(
    segments.slice(2).flatMap((s) => [
      { kind: 'moveTo', x: s.ax, y: s.ay },
      { kind: 'lineTo', x: s.bx, y: s.by },
    ])
  );
});
