import type { FurnaceTransit, Position } from '../shared-types';
import type { FurnaceField } from './furnaceField';
import { civicLot, pipeToTownSquare, TOWN_HEARTH } from './furnaces';

export const FURNACE_TRAVEL = {
  MIN_DURATION_MS: 3_000,
  MAX_DURATION_MS: 8_000,
  SPEED: 3_000,
} as const;

export function nearestTravelFurnace(position: Position, field: FurnaceField) {
  return field
    .nearby(position, TOWN_HEARTH.radius)
    .filter(
      (site) =>
        Math.hypot(site.position.x - position.x, site.position.y - position.y) <= site.radius
    )
    .sort(
      (a, b) =>
        Math.hypot(a.position.x - position.x, a.position.y - position.y) -
        Math.hypot(b.position.x - position.x, b.position.y - position.y)
    )[0];
}

export function litTravelDestinations(sourceId: string, field: FurnaceField) {
  return [
    TOWN_HEARTH,
    ...field.litModules().flatMap((module) => {
      const lot = civicLot(module.id);
      return lot ? [{ ...lot, name: field.displayName(lot.id) }] : [];
    }),
  ].filter((site) => site.id !== sourceId);
}

/** Follow existing pipe runs only, turning at the shared ancestor grate. */
export function planFurnaceRoute(sourceId: string, destinationId: string): Position[] {
  const source = pipeToTownSquare(sourceId);
  const destination = pipeToTownSquare(destinationId);
  if (!source.length || !destination.length || sourceId === destinationId) {
    return [];
  }
  let from = source.length - 1;
  let to = destination.length - 1;
  while (
    from > 0 &&
    to > 0 &&
    source[from - 1]?.x === destination[to - 1]?.x &&
    source[from - 1]?.y === destination[to - 1]?.y
  ) {
    from--;
    to--;
  }
  return [...source.slice(0, from + 1), ...destination.slice(0, to).reverse()].map((point) => ({
    ...point,
  }));
}

export function furnaceTravelDuration(route: readonly Position[]): number {
  let distance = 0;
  for (let index = 1; index < route.length; index++) {
    const previous = route[index - 1];
    const current = route[index];
    if (previous && current) {
      distance += Math.hypot(current.x - previous.x, current.y - previous.y);
    }
  }
  return Math.max(
    FURNACE_TRAVEL.MIN_DURATION_MS,
    Math.min(FURNACE_TRAVEL.MAX_DURATION_MS, (distance / FURNACE_TRAVEL.SPEED) * 1000)
  );
}

const routes = new Map<string, { points: Position[]; lengths: number[]; total: number }>();

export function furnaceTravelPose(transit: FurnaceTransit, now: number) {
  const key = `${transit.sourceId}>${transit.destinationId}`;
  let route = routes.get(key);
  if (!route) {
    const points = planFurnaceRoute(transit.sourceId, transit.destinationId);
    const lengths = points.slice(1).map((point, index) => {
      const previous = points[index];
      return previous ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
    });
    route = { points, lengths, total: lengths.reduce((sum, length) => sum + length, 0) };
    if (points.length < 2) {
      throw new Error('Invalid furnace travel route');
    }
    routes.set(key, route);
  }
  const progress = Math.max(0, Math.min(1, (now - transit.startedAt) / transit.durationMs));
  let remaining = route.total * progress;
  for (let index = 0; index < route.lengths.length; index++) {
    const length = route.lengths[index] ?? 0;
    const start = route.points[index];
    const end = route.points[index + 1];
    if (!start || !end) {
      continue;
    }
    if (remaining <= length || index === route.lengths.length - 1) {
      const portion = length > 0 ? Math.min(1, remaining / length) : 1;
      return {
        position: {
          x: start.x + (end.x - start.x) * portion,
          y: start.y + (end.y - start.y) * portion,
        },
        angle: Math.atan2(-(end.y - start.y), end.x - start.x),
        progress,
      };
    }
    remaining -= length;
  }
  throw new Error('Furnace travel route has no segments');
}
