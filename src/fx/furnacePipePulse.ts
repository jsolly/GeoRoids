import { FURNACE_PIPE_SPEED, pipeToTownSquare } from '../../shared/furnaces';
import type { Position } from '../../shared-types';

/** How long the lit pipe stays bright after the light reaches Town Square. */
export const FURNACE_PIPE_FADE_MS = 400;

const MAX_PULSES = 8;

interface FurnacePipePulse {
  readonly points: readonly Position[];
  readonly startedAt: number;
  readonly travelMs: number;
}

const pulses: FurnacePipePulse[] = [];

export function resetFurnacePipePulses(): void {
  pulses.length = 0;
}

function pipeLength(points: readonly Position[]): number {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    length += Math.hypot(end.x - start.x, end.y - start.y);
  }
  return length;
}

function pointAlongPipe(points: readonly Position[], distance: number): Position {
  let remaining = Math.max(0, distance);
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (!start || !end) {
      continue;
    }
    const span = Math.hypot(end.x - start.x, end.y - start.y);
    if (remaining <= span || index === points.length - 2) {
      const t = span === 0 ? 1 : Math.min(1, remaining / span);
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
    }
    remaining -= span;
  }
  const last = points[points.length - 1];
  return last ? { x: last.x, y: last.y } : { x: 0, y: 0 };
}

/** Light the parent pipes from this furnace back to Town Square. A square delivery has no run. */
export function noteFurnacePipePulse(furnaceId: string, now = performance.now()): boolean {
  const points = pipeToTownSquare(furnaceId);
  if (points.length < 2) {
    return false;
  }
  const travelMs = (pipeLength(points) / FURNACE_PIPE_SPEED) * 1000;
  pulses.push({ points, startedAt: now, travelMs });
  if (pulses.length > MAX_PULSES) {
    pulses.shift();
  }
  return true;
}

export function furnacePipeFrame(
  pulse: FurnacePipePulse,
  now: number
): { head: Position; alpha: number } | undefined {
  const elapsed = now - pulse.startedAt;
  if (elapsed < 0 || elapsed > pulse.travelMs + FURNACE_PIPE_FADE_MS) {
    return undefined;
  }
  const travel = Math.min(1, pulse.travelMs === 0 ? 1 : elapsed / pulse.travelMs);
  const alpha =
    elapsed <= pulse.travelMs ? 1 : 1 - (elapsed - pulse.travelMs) / FURNACE_PIPE_FADE_MS;
  return { head: pointAlongPipe(pulse.points, travel * pipeLength(pulse.points)), alpha };
}

export function activeFurnacePipePulses(now = performance.now()): readonly FurnacePipePulse[] {
  for (let index = pulses.length - 1; index >= 0; index -= 1) {
    const pulse = pulses[index];
    if (pulse && now - pulse.startedAt > pulse.travelMs + FURNACE_PIPE_FADE_MS) {
      pulses.splice(index, 1);
    }
  }
  return pulses;
}
