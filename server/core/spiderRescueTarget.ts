import { SPIDER } from '../../shared/terrainSpider';
import type { Position, TerrainSpider } from '../../shared-types';

type RescueTow = {
  owner: { position: Position };
  friend: Pick<TerrainSpider, 'id' | 'position'>;
};

/** Select the nearest reachable cable, with stable ties between captive spiders. */
export function nearestRescueTow<T extends RescueTow>(
  position: Position,
  tows: readonly T[],
  guardHome?: Position
): { tow: T; point: Position; distance: number } | undefined {
  return tows
    .flatMap((tow) => {
      const start = tow.owner.position;
      const end = tow.friend.position;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const fraction =
        lengthSquared > 0
          ? Math.max(
              0,
              Math.min(
                1,
                ((position.x - start.x) * dx + (position.y - start.y) * dy) / lengthSquared
              )
            )
          : 0;
      const point = { x: start.x + dx * fraction, y: start.y + dy * fraction };
      const distance = Math.hypot(position.x - point.x, position.y - point.y);
      if (
        distance > SPIDER.RESCUE_ATTRACT_DISTANCE ||
        (guardHome &&
          Math.hypot(point.x - guardHome.x, point.y - guardHome.y) > SPIDER.NEST_LEASH_DISTANCE)
      ) {
        return [];
      }
      return [{ tow, point, distance }];
    })
    .sort((a, b) => a.distance - b.distance || a.tow.friend.id.localeCompare(b.tow.friend.id))[0];
}
