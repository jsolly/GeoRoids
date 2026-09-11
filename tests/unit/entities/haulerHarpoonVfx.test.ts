import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { publishHarpoonField } from '../../../src/entities/ship/harpoonField';
import { Ship } from '../../../src/entities/ship/Ship';
import { HAULER_TETHER_COLOR, HAULER_TETHER_TIP_COLOR } from '../../../src/entities/ship/shipKits';
import {
  canDrawGenericAbilityRing,
  canDrawHaulerHarpoon,
  drawHaulerHarpoonVfx,
  harpoonTetherStyle,
} from '../../../src/entities/ship/shipRenderer';

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

test('drawHaulerHarpoonVfx paints cream and tip as same-module hex literals', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../src/entities/ship/shipRenderer.ts'),
    'utf8'
  );
  const paint = source.slice(source.indexOf('export function drawHaulerHarpoonVfx'));
  expect(paint).toContain("ctx.strokeStyle = '#E8D5A3'");
  expect(paint).toContain("ctx.fillStyle = '#FDE68A'");
  expect(paint).toContain("ctx.strokeStyle = '#FDE68A'");
  expect(paint).not.toContain('HAULER_TETHER_COLOR');
  expect(paint).not.toContain('HAULER_TETHER_TIP_COLOR');
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
