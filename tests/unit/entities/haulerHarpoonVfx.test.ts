import { expect, test } from 'vitest';
import { Roid } from '../../../src/entities/roid/Roid';
import {
  harpoonBodiesFromRocks,
  publishHarpoonField,
} from '../../../src/entities/ship/harpoonField';
import { Ship } from '../../../src/entities/ship/Ship';
import { HAULER_TETHER_COLOR, HAULER_TETHER_TIP_COLOR } from '../../../src/entities/ship/shipKits';
import {
  canDrawGenericAbilityRing,
  canDrawHaulerHarpoon,
  drawHaulerHarpoonVfx,
  harpoonTetherStyle,
} from '../../../src/entities/ship/shipRenderer';
import { canvasManager } from '../../../src/rendering/canvas';

test('tether VFX is Hauler-only while latched', () => {
  expect(
    canDrawHaulerHarpoon({ kitId: 'hauler', harpoonTimer: 40, harpoonTargetId: 'rock-1' })
  ).toBe(true);
  expect(canDrawHaulerHarpoon({ kitId: 'dart', harpoonTimer: 40, harpoonTargetId: 'rock-1' })).toBe(
    false
  );
  expect(
    canDrawHaulerHarpoon({ kitId: 'hauler', harpoonTimer: 0, harpoonTargetId: 'rock-1' })
  ).toBe(false);
  expect(canDrawHaulerHarpoon({ kitId: 'hauler', harpoonTimer: 40 })).toBe(false);
  expect(
    canDrawHaulerHarpoon({
      kitId: 'hauler',
      harpoonTimer: 40,
      harpoonLatchPos: { x: 40, y: 0 },
    })
  ).toBe(true);
});

test('Hauler never paints the generic activation ring', () => {
  expect(
    canDrawGenericAbilityRing({
      kitId: 'hauler',
      abilityActiveFrames: 40,
      harpoonTimer: 0,
      shieldTimer: 0,
    })
  ).toBe(false);
  expect(
    canDrawGenericAbilityRing({
      kitId: 'dart',
      abilityActiveFrames: 12,
      harpoonTimer: 0,
      shieldTimer: 0,
    })
  ).toBe(true);
});

test('PASS bar cream line and amber tip are exact hex', () => {
  expect(HAULER_TETHER_COLOR).toBe('#E8D5A3');
  expect(HAULER_TETHER_TIP_COLOR).toBe('#FDE68A');
});

test('tethers stay solid and hairline in screen space at every zoom', () => {
  expect(harpoonTetherStyle().dash).toEqual([]);
  expect(harpoonTetherStyle().lineWidth).toBe(1.5);
  expect(harpoonTetherStyle().tipRadius).toBe(3.5);
});

test('tether VFX can resolve a latched ship from the shared field', () => {
  publishHarpoonField([
    {
      id: 'bob',
      position: { x: 80, y: 0 },
      velocity: { x: 0, y: 0 },
      kind: 'ship',
      health: 100,
    },
  ]);
  expect(canDrawHaulerHarpoon({ kitId: 'hauler', harpoonTimer: 40, harpoonTargetId: 'bob' })).toBe(
    true
  );
});

function paintRecorder(): {
  ctx: CanvasRenderingContext2D;
  strokes: string[];
  fills: string[];
  strokeWidths: number[];
  arcRadii: number[];
  lines: number[][];
} {
  const strokes: string[] = [];
  const fills: string[] = [];
  const strokeWidths: number[] = [];
  const arcRadii: number[] = [];
  const lines: number[][] = [];
  let pen = { x: 0, y: 0 };
  const state = {
    strokeStyle: '',
    fillStyle: '',
    shadowColor: '',
    shadowBlur: 0,
    lineWidth: 0,
  };
  const ctx = {
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(value: string) {
      state.strokeStyle = value;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    set shadowColor(value: string) {
      state.shadowColor = value;
    },
    get shadowBlur() {
      return state.shadowBlur;
    },
    set shadowBlur(value: number) {
      state.shadowBlur = value;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(value: number) {
      state.lineWidth = value;
    },
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: (x: number, y: number) => {
      pen = { x, y };
    },
    lineTo: (x: number, y: number) => {
      lines.push([pen.x, pen.y, x, y]);
      pen = { x, y };
    },
    arc: (...args: unknown[]) => {
      const radius = args[2];
      if (typeof radius === 'number') {
        arcRadii.push(radius);
      }
    },
    setLineDash: () => undefined,
    stroke() {
      strokes.push(state.strokeStyle);
      strokeWidths.push(state.lineWidth);
    },
    fill() {
      fills.push(state.fillStyle);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, strokes, fills, strokeWidths, arcRadii, lines };
}

test('tether VFX still resolves a server asteroid id suffix', () => {
  publishHarpoonField([
    { id: 'server-asteroid-10', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } },
  ]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 40;
  hauler.harpoonTargetId = 'asteroid-10';
  const { ctx, strokes, fills, strokeWidths, arcRadii } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(strokes).toContain('#E8D5A3');
  expect(strokes).toContain('#FDE68A');
  expect(fills).toContain('#FDE68A');
  expect(strokeWidths.every((width) => width <= 2)).toBe(true);
  expect(arcRadii).toEqual([3.5]);
});

test('timer-only Hauler still paints cream from the nearest field rock', () => {
  publishHarpoonField([
    { id: 'near', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 }, kind: 'asteroid' },
  ]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 40;
  const { ctx, strokes, fills, strokeWidths, arcRadii } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(strokes).toContain('#E8D5A3');
  expect(strokes).toContain('#FDE68A');
  expect(fills).toContain('#FDE68A');
  expect(strokeWidths.every((width) => width <= 2)).toBe(true);
  expect(arcRadii).toEqual([3.5]);
  expect(hauler.harpoonLatchPos?.x).toBe(40);
});

test('a surface latch retains its contact point and paints a second cream payload cable', () => {
  publishHarpoonField([
    { id: 'primary', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 }, r: 10 },
    { id: 'payload', position: { x: 100, y: 0 }, velocity: { x: 0, y: 0 }, r: 12 },
  ]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 1;
  hauler.harpoonTargetId = 'primary';
  hauler.harpoonLatchPos = { x: 30, y: 0 };
  hauler.asteroidMotion = {
    epoch: 1,
    mode: 'latched',
    ack: 0,
    asteroidId: 'primary',
    payloadId: 'payload',
  };
  const { ctx, strokes } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(hauler.harpoonLatchPos).toEqual({ x: 30, y: 0 });
  expect(strokes.filter((color) => color === '#E8D5A3')).toHaveLength(2);
});

test('payload cables follow the actual rotating faceted rock contours through the live field converter', () => {
  const primary = new Roid({ x: 40, y: 0 }, 10, 'primary');
  Object.assign(primary, { angle: Math.PI / 4, vertices: 4, offsets: [1, 1, 1, 1] });
  const payload = new Roid({ x: 100, y: 0 }, 12, 'payload');
  Object.assign(payload, { angle: 0, vertices: 4, offsets: [1, 0.8, 0.5, 1.2] });
  publishHarpoonField(harpoonBodiesFromRocks([primary, payload]));
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 1;
  hauler.harpoonTargetId = 'primary';
  hauler.harpoonLatchPos = { x: 30, y: 0 };
  hauler.asteroidMotion = {
    epoch: 1,
    mode: 'latched',
    ack: 0,
    asteroidId: 'primary',
    payloadId: 'payload',
  };
  const camera = { x: -10, y: 5 };
  const painted = paintRecorder();
  drawHaulerHarpoonVfx(painted.ctx, hauler, 0, 0, camera);
  const primaryFace = canvasManager.worldToScreen({ x: 40 + 10 / Math.SQRT2, y: 0 }, camera);
  const payloadVertex = canvasManager.worldToScreen({ x: 100 - 12 * 0.5, y: 0 }, camera);
  expect(painted.lines).toHaveLength(2);
  expect(painted.lines[1]?.[0]).toBeCloseTo(primaryFace.x, 8);
  expect(painted.lines[1]?.[1]).toBeCloseTo(primaryFace.y, 8);
  expect(painted.lines[1]?.[2]).toBeCloseTo(payloadVertex.x, 8);
  expect(painted.lines[1]?.[3]).toBeCloseTo(payloadVertex.y, 8);
  expect(hauler.harpoonLatchPos).toEqual({ x: 30, y: 0 });

  primary.angle = 0;
  publishHarpoonField(harpoonBodiesFromRocks([primary, payload]));
  const rotated = paintRecorder();
  drawHaulerHarpoonVfx(rotated.ctx, hauler, 0, 0, camera);
  expect(rotated.lines[1]?.[0]).toBeCloseTo(
    canvasManager.worldToScreen({ x: 50, y: 0 }, camera).x,
    8
  );
  expect(rotated.lines[1]?.[2]).toBeCloseTo(payloadVertex.x, 8);

  // Ordinary E remains a single cable to the moving target center.
  delete hauler.asteroidMotion;
  const ordinary = paintRecorder();
  drawHaulerHarpoonVfx(ordinary.ctx, hauler, 0, 0, camera);
  const center = canvasManager.worldToScreen(primary.position, camera);
  expect(ordinary.lines).toEqual([[0, 0, center.x, center.y]]);
  expect(hauler.harpoonLatchPos).toEqual(primary.position);
});

test('tether VFX still paints from a stored latch pose when the field id is stale', () => {
  publishHarpoonField([]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 40;
  hauler.harpoonTargetId = 'server-asteroid-0';
  hauler.harpoonLatchPos = { x: 40, y: 0 };
  const { ctx, strokes, fills, strokeWidths, arcRadii } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(strokes).toContain('#E8D5A3');
  expect(strokes).toContain('#FDE68A');
  expect(fills).toContain('#FDE68A');
  expect(strokeWidths.every((width) => width <= 2)).toBe(true);
  expect(arcRadii).toEqual([3.5]);
});

test('cream cable still paints while the Hauler hull is exploding', () => {
  publishHarpoonField([{ id: 'rock-1', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } }]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 40;
  hauler.harpoonTargetId = 'rock-1';
  hauler.exploding = true;
  hauler.health = 0;
  const { ctx, strokes, fills } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(strokes).toContain('#E8D5A3');
  expect(fills).toContain('#FDE68A');
});

test('Hauler latch paints opaque cream line and amber tip', () => {
  publishHarpoonField([{ id: 'rock-1', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } }]);
  const hauler = new Ship({ kitId: 'hauler' });
  hauler.harpoonTimer = 40;
  hauler.harpoonTargetId = 'rock-1';
  const { ctx, strokes, fills } = paintRecorder();
  drawHaulerHarpoonVfx(ctx, hauler, 0, 0, { x: 0, y: 0 });
  expect(strokes).toContain('#E8D5A3');
  expect(strokes).toContain('#FDE68A');
  expect(fills).toContain('#FDE68A');
});

test('non-Hauler draw is a no-op even if a latch is spoofed', () => {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    setLineDash: () => calls.push('setLineDash'),
  } as unknown as CanvasRenderingContext2D;
  publishHarpoonField([{ id: 'rock-1', position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } }]);
  const dart = new Ship({ kitId: 'dart' });
  dart.harpoonTimer = 40;
  dart.harpoonTargetId = 'rock-1';
  drawHaulerHarpoonVfx(ctx, dart, 0, 0, { x: 0, y: 0 });
  expect(calls).toEqual([]);
});
