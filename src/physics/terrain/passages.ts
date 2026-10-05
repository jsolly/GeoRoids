import type { Heightfield } from './heightfield';

/** Narrow interconnected cuts; all sampling is constant-time, without route state. */
export const PASSAGES = {
  SPACING: 1100,
  HALF_WIDTH: 90,
  RELIEF_RETAINED: 0.08,
  HORIZONTAL_OFFSET: 330,
  VERTICAL_OFFSET: 570,
  VERTICAL_PHASE: 2.1,
};

interface Passage {
  strength: number;
}

export function passagePhase(seed: number): number {
  return (((seed >>> 0) % 65536) / 65536) * Math.PI * 2;
}

export function passageAxis(value: number, phase: number): { offset: number; width: number } {
  const a = value / 620 + phase;
  const b = value / 277 - phase;
  return {
    offset: 190 * Math.sin(a) + 55 * Math.sin(b),
    width:
      PASSAGES.HALF_WIDTH * Math.hypot(1, (190 / 620) * Math.cos(a) + (55 / 277) * Math.cos(b)),
  };
}

export function passageBand(value: number, width: number, envelope: number): number {
  const distance = Math.abs(value - Math.round(value / PASSAGES.SPACING) * PASSAGES.SPACING);
  const t = Math.max(0, 1 - distance / width);
  return t * t * (3 - 2 * t) * envelope;
}

export function passageEnvelope(lx: number, ly: number, worldRadius: number): number {
  const radius = Math.hypot(lx, ly);
  // Keep the starter area ordinary; meet the world edge with no discontinuity.
  const fade = Math.max(0, Math.min(1, (radius - 450) / 350, (worldRadius - radius) / 260));
  return fade * fade * (3 - 2 * fade);
}

/** Two warped families shape the contour field into narrow, connected cuts. */
export function samplePassages(field: Heightfield, x: number, y: number): [Passage, Passage] {
  const lx = x - field.cx;
  const ly = y - field.cy;
  const envelope = passageEnvelope(lx, ly, field.radius);
  const phase = passagePhase(field.seed);
  const horizontal = passageAxis(lx, phase);
  const vertical = passageAxis(ly, phase + PASSAGES.VERTICAL_PHASE);
  return [
    {
      strength: passageBand(
        ly - horizontal.offset - PASSAGES.HORIZONTAL_OFFSET,
        horizontal.width,
        envelope
      ),
    },
    {
      strength: passageBand(
        lx - vertical.offset - PASSAGES.VERTICAL_OFFSET,
        vertical.width,
        envelope
      ),
    },
  ];
}

export function passageStrength(field: Heightfield, x: number, y: number): number {
  const [horizontal, vertical] = samplePassages(field, x, y);
  return Math.max(horizontal.strength, vertical.strength);
}
