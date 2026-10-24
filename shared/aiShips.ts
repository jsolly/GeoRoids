import type { Position } from '../shared-types';
import { GAME } from './constants/gameplay';
import { TOWN_HEARTH } from './furnaces';

/** One bounded fleet per inhabited world, independent of explored sector count. */
export const AI_SHIPS = {
  spawnDelayFrames: 5 * GAME.FPS,
  shotIntervalFrames: 90,
  sanctuaryRadius: 600,
  tetherRadius: 1_800,
  workRadius: 700,
  workerLoiterRadius: 450,
  workerLoiterTolerance: 100,
  avoidRadius: 200,
  engagementRadius: 900,
} as const;

export function inBotSanctuary(position: Position): boolean {
  return (
    Math.hypot(position.x - TOWN_HEARTH.position.x, position.y - TOWN_HEARTH.position.y) <=
    AI_SHIPS.sanctuaryRadius
  );
}
