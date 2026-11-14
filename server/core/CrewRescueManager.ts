import { SHIP } from '../../shared/constants/gameplay';
import { calculateHealthRegenDelayFrames } from '../../shared/constants/health';
import { COOPERATIVE } from '../../shared/cooperativeRules';
import type { CrewAction, Position } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { EntityManager, GameEntity } from './EntityManager';
import type { PlayerMotionService } from './PlayerMotionService';

type RescueAction = Exclude<CrewAction, { kind: 'withdraw-supply' }>;

type CrewRescueInputs = {
  readonly actors: Pick<EntityManager, 'getEntity' | 'getAllEntities'>;
  readonly campaign: Pick<CooperativeCampaign, 'activated' | 'get' | 'set' | 'removeDowned'>;
  readonly motion: Pick<PlayerMotionService, 'invalidateLife'>;
  readonly now: () => number;
  readonly cancelCharge: (actor: GameEntity) => void;
  readonly cancelBoost: (id: string, targetId: GameEntity['harpoonTargetId']) => boolean;
  readonly capturePilot: (id: string) => void;
  readonly terminalDeath: (actor: GameEntity, cause: string) => void;
};

/** Owns rescue holds, downed transitions and crew signals; never commits storage. */
export class CrewRescueManager {
  private readonly lastCrewSignalAt = new Map<string, number>();

  constructor(private readonly inputs: CrewRescueInputs) {}

  act(id: string, action: RescueAction): boolean {
    const actor = this.inputs.actors.getEntity(id);
    if (!this.inputs.campaign.activated || !actor?.ws || actor.furnaceTransit) {
      return false;
    }
    const now = this.inputs.now();
    if (action.kind === 'release') {
      this.cancel(id);
      return true;
    }
    if (action.kind === 'give-up') {
      if (actor.downedUntil == null || actor.downedUntil === 0 || Number.isNaN(actor.downedUntil)) {
        return false;
      }
      this.finish(actor);
      return true;
    }
    if (action.kind === 'signal') {
      if (
        (actor.health <= 0 &&
          (actor.downedUntil == null ||
            actor.downedUntil === 0 ||
            Number.isNaN(actor.downedUntil))) ||
        actor.exploding ||
        now - (this.lastCrewSignalAt.get(id) ?? -Infinity) < COOPERATIVE.signalCooldownMs ||
        Math.hypot(action.position.x - actor.position.x, action.position.y - actor.position.y) >
          COOPERATIVE.signalRadius
      ) {
        return false;
      }
      actor.crewSignal = {
        kind: action.signal,
        position: { ...action.position },
        expiresAt: Math.floor(now + COOPERATIVE.signalLifetimeMs),
      };
      this.lastCrewSignalAt.set(id, now);
      return true;
    }
    const target = this.inputs.actors.getEntity(action.targetId);
    if (
      !target?.ws ||
      target.downedUntil == null ||
      target.downedUntil === 0 ||
      Number.isNaN(target.downedUntil) ||
      target.downedUntil <= now ||
      target.id === id ||
      actor.health <= 0 ||
      actor.exploding ||
      actor.overlayHold === true ||
      (actor.downedUntil != null && actor.downedUntil !== 0 && !Number.isNaN(actor.downedUntil)) ||
      Math.hypot(actor.position.x - target.position.x, actor.position.y - target.position.y) >
        COOPERATIVE.reviveRadius
    ) {
      return false;
    }
    if (actor.rescue?.targetId === target.id) {
      return true;
    }
    actor.rescue = { targetId: target.id, completesAt: Math.floor(now + COOPERATIVE.reviveMs) };
    actor.velocity = { x: 0, y: 0 };
    actor.thrusting = false;
    actor.contourLock = null;
    actor.knockbackVelocityLimit = 0;
    this.inputs.motion.invalidateLife(actor.id, now);
    return true;
  }

  cancelOnMovement(id: string, position?: Position, velocity?: Position, angle?: number): void {
    const actor = this.inputs.actors.getEntity(id);
    if (
      actor?.rescue &&
      ((position &&
        Math.hypot(position.x - actor.position.x, position.y - actor.position.y) > 0.5) ||
        (velocity && Math.hypot(velocity.x, velocity.y) > 0.01) ||
        (angle !== undefined && Math.abs(angle - actor.angle) > 0.01))
    ) {
      this.cancel(id);
    }
  }

  cancel(id: string): void {
    const actor = this.inputs.actors.getEntity(id);
    if (actor?.rescue) {
      actor.rescue = null;
    }
  }

  down(actor: GameEntity, cause: string): void {
    this.inputs.cancelCharge(actor);
    const deadline = Math.floor(this.inputs.now() + COOPERATIVE.downedMs);
    actor.downedUntil = deadline;
    actor.deathCause = cause;
    actor.exploding = false;
    delete actor.explodeTime;
    actor.velocity = { x: 0, y: 0 };
    actor.thrusting = false;
    actor.contourLock = null;
    this.inputs.cancelBoost(actor.id, actor.harpoonTargetId);
    actor.harpoonTargetId = null;
    actor.utilityFlight = null;
    actor.abilityActiveFrames = 0;
    this.inputs.campaign.set({
      kind: 'downed',
      id: actor.id,
      position: { ...actor.position },
      deadline,
      cause,
    });
    this.inputs.motion.invalidateLife(actor.id, this.inputs.now());
    this.inputs.capturePilot(actor.id);
  }

  private finish(actor: GameEntity): void {
    if (actor.downedUntil == null || actor.downedUntil === 0 || Number.isNaN(actor.downedUntil)) {
      return;
    }
    actor.downedUntil = null;
    // Downed clients stop sending poses; the respawn is fresh authoritative activity.
    actor.lastUpdate = this.inputs.now();
    this.inputs.campaign.removeDowned(actor.id);
    actor.exploding = true;
    actor.explodeTime = SHIP.EXPLODE_DURATION_FRAMES;
    this.inputs.terminalDeath(actor, actor.deathCause ?? 'asteroid');
  }

  advance(now: number): void {
    if (!this.inputs.campaign.activated) {
      return;
    }
    const players = this.inputs.actors
      .getAllEntities()
      .filter((actor) => actor.botRole === undefined);
    for (const actor of players) {
      if (actor.crewSignal && actor.crewSignal.expiresAt <= now) {
        actor.crewSignal = null;
      }
      if (
        actor.downedUntil != null &&
        actor.downedUntil !== 0 &&
        !Number.isNaN(actor.downedUntil) &&
        actor.downedUntil <= now
      ) {
        this.finish(actor);
      }
    }
    for (const actor of players) {
      const rescue = actor.rescue;
      if (!rescue) {
        continue;
      }
      const target = this.inputs.actors.getEntity(rescue.targetId);
      if (
        !actor.ws ||
        actor.health <= 0 ||
        actor.exploding ||
        actor.overlayHold === true ||
        actor.furnaceTransit ||
        !target?.ws ||
        target.downedUntil == null ||
        target.downedUntil === 0 ||
        Number.isNaN(target.downedUntil) ||
        Math.hypot(actor.position.x - target.position.x, actor.position.y - target.position.y) >
          COOPERATIVE.reviveRadius ||
        Math.hypot(actor.velocity.x, actor.velocity.y) > 0.01
      ) {
        this.cancel(actor.id);
        continue;
      }
      actor.velocity = { x: 0, y: 0 };
      actor.thrusting = false;
      if (now < rescue.completesAt) {
        continue;
      }
      target.downedUntil = null;
      target.lastUpdate = now;
      target.health = target.maxHealth * COOPERATIVE.reviveHealthFraction;
      target.healthRegenTimer = calculateHealthRegenDelayFrames();
      target.spawnProtectionTimer = SHIP.INVINCIBILITY_DURATION_FRAMES;
      target.exploding = false;
      delete target.deathCause;
      this.inputs.campaign.removeDowned(target.id);
      this.inputs.motion.invalidateLife(target.id, now);
      this.inputs.capturePilot(target.id);
      this.cancel(actor.id);
    }
  }

  finishIfExpired(actor: GameEntity): void {
    if (
      actor.downedUntil != null &&
      actor.downedUntil !== 0 &&
      !Number.isNaN(actor.downedUntil) &&
      actor.downedUntil <= this.inputs.now()
    ) {
      this.finish(actor);
    }
  }

  restoreDowned(actor: GameEntity): boolean {
    const downed = this.inputs.campaign.get('downed', actor.id);
    if (downed == null) {
      return false;
    }
    actor.position = { ...downed.position };
    actor.health = 0;
    actor.downedUntil = downed.deadline;
    actor.deathCause = downed.cause;
    actor.exploding = false;
    actor.velocity = { x: 0, y: 0 };
    delete actor.spawnProtectionTimer;
    if (this.inputs.now() >= downed.deadline) {
      this.finish(actor);
    }
    this.inputs.motion.invalidateLife(actor.id, this.inputs.now());
    return true;
  }

  forget(id: string): void {
    this.cancel(id);
    this.lastCrewSignalAt.delete(id);
  }

  transportClosed(id: string): void {
    this.cancel(id);
    const players = this.inputs.actors
      .getAllEntities()
      .filter((actor) => actor.botRole === undefined);
    for (const rescuer of players) {
      if (rescuer.rescue?.targetId === id) {
        this.cancel(rescuer.id);
      }
    }
  }

  /** Full campaign/session reset only; diagnostic world rearrangement retains cooldowns. */
  reset(): void {
    this.lastCrewSignalAt.clear();
  }
}
