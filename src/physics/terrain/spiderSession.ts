import { SPIDER } from '../../../shared/terrainSpider';
import type { Position, SpiderFieldState } from '../../../shared-types';
import { resetSpiderScore, type SpiderDanger } from '../../audio/spiderScore';

const empty: SpiderFieldState = { spiders: [] };
let sessionField: SpiderFieldState = empty;

export function setSpiderField(state: SpiderFieldState | undefined): void {
  sessionField = state ?? empty;
  if (!state) {
    resetSpiderScore();
  }
}

export function getSpiderField(): SpiderFieldState {
  return sessionField;
}

/** Danger follows the predator, not a fabricated terrain trap. */
export function spiderDanger(
  position: Position,
  field: SpiderFieldState,
  playerId: string
): SpiderDanger {
  if (field.spiders.some((spider) => spider.phase === 'hunting' && spider.targetId === playerId)) {
    return 'hunted';
  }
  return field.spiders.some(
    (spider) =>
      Math.hypot(position.x - spider.position.x, position.y - spider.position.y) <
      SPIDER.INFLUENCE_RADIUS + 280
  )
    ? 'nearby'
    : 'quiet';
}
