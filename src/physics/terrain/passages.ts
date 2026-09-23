import type { Heightfield } from './heightfield';

/** Narrow interconnected cuts; all sampling is constant-time, without route state. */
export const PASSAGES = {
  SPACING: 1100,
  HALF_WIDTH: 90,
  SPEED_BONUS: 0.5,
  RELIEF_RETAINED: 0.08,
};

interface Passage {
  strength: number;
  tangentX: number;
  tangentY: number;
}

function wave(value: number, phase: number): { offset: number; derivative: number } {
  const a = value / 620 + phase;
  const b = value / 277 - phase;
  return {
    offset: 190 * Math.sin(a) + 55 * Math.sin(b),
    derivative: (190 / 620) * Math.cos(a) + (55 / 277) * Math.cos(b),
  };
}

function band(value: number, derivative: number, envelope: number): number {
  const distance = Math.abs(value - Math.round(value / PASSAGES.SPACING) * PASSAGES.SPACING);
  const t = Math.max(0, 1 - distance / (PASSAGES.HALF_WIDTH * Math.hypot(1, derivative)));
  return t * t * (3 - 2 * t) * envelope;
}

/** Two warped families meet as forks. Each retains its tangent at a junction. */
export function samplePassages(field: Heightfield, x: number, y: number): [Passage, Passage] {
  const lx = x - field.cx;
  const ly = y - field.cy;
  const radius = Math.hypot(lx, ly);
  // Keep the starter area ordinary; meet the world edge with no discontinuity.
  const fade = Math.max(0, Math.min(1, (radius - 450) / 350, (field.radius - radius) / 260));
  const envelope = fade * fade * (3 - 2 * fade);
  const phase = (((field.seed >>> 0) % 65536) / 65536) * Math.PI * 2;
  const horizontal = wave(lx, phase);
  const vertical = wave(ly, phase + 2.1);
  const hLength = Math.hypot(1, horizontal.derivative);
  const vLength = Math.hypot(1, vertical.derivative);
  return [
    {
      strength: band(ly - horizontal.offset - 330, horizontal.derivative, envelope),
      tangentX: 1 / hLength,
      tangentY: horizontal.derivative / hLength,
    },
    {
      strength: band(lx - vertical.offset - 570, vertical.derivative, envelope),
      tangentX: vertical.derivative / vLength,
      tangentY: 1 / vLength,
    },
  ];
}

export function passageStrength(field: Heightfield, x: number, y: number): number {
  const [horizontal, vertical] = samplePassages(field, x, y);
  return Math.max(horizontal.strength, vertical.strength);
}

export function passageAlignment(field: Heightfield, x: number, y: number, angle: number): number {
  const headingX = Math.cos(angle);
  const headingY = -Math.sin(angle);
  let alignment = 0;
  for (const passage of samplePassages(field, x, y)) {
    const dot = headingX * passage.tangentX + headingY * passage.tangentY;
    alignment = Math.max(alignment, passage.strength * dot ** 4);
  }
  return alignment;
}
