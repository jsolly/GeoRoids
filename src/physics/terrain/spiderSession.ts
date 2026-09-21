import { SPIDER } from '../../../shared/terrainSpider';
import type { Position, SpiderFieldState } from '../../../shared-types';
import { resetSpiderScore, type SpiderDanger } from '../../audio/spiderScore';
import { playSpiderWhimper, stopSpiderWhimpers } from '../../audio/spiderWhimper';
import { noteFurnacePipePulse } from '../../fx/furnacePipePulse';

const empty: SpiderFieldState = { spiders: [], nests: [] };
let sessionField: SpiderFieldState = empty;
let initialized = false;
let seenConsumptions = new Set<string>();
const consumptionEffects: { position: Position; startedAt: number }[] = [];

export function getSpiderConsumptionEffects(): readonly {
  position: Position;
  startedAt: number;
}[] {
  const cutoff = performance.now() / 1000 - 1;
  while (consumptionEffects[0] && consumptionEffects[0].startedAt < cutoff) {
    consumptionEffects.shift();
  }
  return consumptionEffects;
}

export function setSpiderField(state: SpiderFieldState | undefined): void {
  const events = state?.consumed ?? [];
  if (initialized) {
    for (const event of events) {
      const key = `${event.id}:${event.frame}`;
      if (!seenConsumptions.has(key)) {
        consumptionEffects.push({
          position: { ...event.position },
          startedAt: performance.now() / 1000,
        });
        noteFurnacePipePulse(event.furnaceId);
        playSpiderWhimper(event.position);
      }
    }
  }
  seenConsumptions = new Set(events.map((event) => `${event.id}:${event.frame}`));
  initialized = state !== undefined;
  sessionField = state ?? empty;
  if (!state) {
    resetSpiderScore();
    stopSpiderWhimpers();
    consumptionEffects.length = 0;
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
