import { SHIP } from '../../shared/constants/gameplay';
import type { FurnaceField } from '../../shared/furnaceField';
import {
  furnaceTravelDuration,
  furnaceTravelPose,
  nearestTravelFurnace,
  planFurnaceRoute,
} from '../../shared/furnaceTravel';
import { GAME_TICK_MS } from '../../shared/gameClock';
import { clearHaulerLatch } from '../../shared/shipAbilities';
import type { EntityManager, GameEntity } from './EntityManager';
import type { PlayerMotionService } from './PlayerMotionService';

type FurnaceTravelInputs = Readonly<{
  actors: Pick<EntityManager, 'getEntity'>;
  furnaces: Pick<FurnaceField, 'nearby' | 'isLit'>;
  motion: Pick<PlayerMotionService, 'handoffActor'>;
  frame: () => number;
  now: () => number;
  cancelArmedBoost: (ownerId: string, targetId: string | null) => boolean;
}>;

/** Owns admission, simulation-frame progress and motion handoff for pipe travel. */
export class FurnaceTravelManager {
  private readonly startedFrames = new Map<string, number>();

  constructor(private readonly inputs: FurnaceTravelInputs) {}

  start(entityId: string, destinationId: string): string | undefined {
    const actor = this.inputs.actors.getEntity(entityId);
    if (!actor || actor.exploding || actor.health <= 0 || actor.respawnTimer !== undefined) {
      return 'Your ship is not ready to travel';
    }
    if (actor.furnaceTransit) {
      return 'Already travelling';
    }
    const source = nearestTravelFurnace(actor.position, this.inputs.furnaces);
    if (!source) {
      return 'Move onto a lit furnace';
    }
    if (!this.inputs.furnaces.isLit(destinationId)) {
      return 'That furnace is not lit';
    }
    const route = planFurnaceRoute(source.id, destinationId);
    if (route.length < 2) {
      return 'Choose another lit furnace';
    }
    const now = this.inputs.now();
    this.inputs.cancelArmedBoost(actor.id, actor.harpoonTargetId);
    clearHaulerLatch(actor);
    actor.abilityActiveFrames = 0;
    actor.contourLock = null;
    actor.velocity = { x: 0, y: 0 };
    actor.thrusting = false;
    actor.overlayHold = true;
    actor.utilityFlight = null;
    actor.furnaceTransit = {
      sourceId: source.id,
      destinationId,
      startedAt: now,
      durationMs: furnaceTravelDuration(route),
    };
    actor.position = { ...source.position };
    this.startedFrames.set(actor.id, this.inputs.frame());
    this.inputs.motion.handoffActor(actor.id, now);
    return undefined;
  }

  finish(actor: GameEntity, now: number): void {
    const transit = actor.furnaceTransit;
    if (!transit) {
      return;
    }
    const pose = furnaceTravelPose(transit, transit.startedAt + transit.durationMs);
    actor.position = pose.position;
    actor.angle = pose.angle;
    actor.velocity = { x: 0, y: 0 };
    actor.thrusting = false;
    actor.furnaceTransit = null;
    actor.overlayHold = false;
    actor.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
    actor.lastUpdate = now;
    this.startedFrames.delete(actor.id);
    this.inputs.motion.handoffActor(actor.id, now);
  }

  advance(frame: number, now: number): void {
    for (const [id, startedFrame] of this.startedFrames) {
      const actor = this.inputs.actors.getEntity(id);
      const transit = actor?.furnaceTransit;
      if (!actor || !transit) {
        this.startedFrames.delete(id);
        continue;
      }
      const pose = furnaceTravelPose(
        transit,
        transit.startedAt + (frame - startedFrame) * GAME_TICK_MS
      );
      actor.position = pose.position;
      actor.angle = pose.angle;
      actor.velocity = { x: 0, y: 0 };
      actor.lastUpdate = now;
      if (pose.progress >= 1) {
        this.finish(actor, now);
      }
    }
  }
}
