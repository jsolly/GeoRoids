import { logger } from '../../setup/serverLogger';
import { isCombatantImmune, isWorldHazard } from '../../shared/combat';
import { calculateHealthRegenDelayFrames } from '../../shared/constants/health';
import { ECONOMY } from '../../shared/economy';
import { GROWTH } from '../../shared/shipGrowth';
import { hullRadiusForKit } from '../../shared/shipKits';
import { captureDiagnosticActorState } from '../../shared/stateDiagnostics';
import { SERVER_RELEASE_ID } from '../release';
import type { GameEntity } from './EntityManager';
import type { ShipDamageInputs, ShipDamageOutcome } from './types';

/** Owns authoritative ship damage, recoverable cargo spills and damage diagnostics. */
export class ShipDamage {
  private readonly damageStateLogs = new WeakMap<GameEntity, number>();

  constructor(private readonly inputs: ShipDamageInputs) {}

  /**
   * Apply damage through one path. Protection, loot, and deathCause stay on
   * the tip helpers; health/cargo stay server-owned.
   */
  apply(targetId: string, attackerId: string, damage: number): ShipDamageOutcome {
    logger.debug('handleShipDamage called', { targetId, attackerId, damage });
    // Crew remain safe from allied fire and rams. Opposing factions and world
    // hazards, including bounced lasers, use the same authoritative damage path.
    const target = this.inputs.actors.getEntity(targetId);
    const opposedShot =
      (attackerId === 'raider' && target?.botRole !== 'raider') ||
      (attackerId === 'crew-fire' && target?.botRole === 'raider');
    if (!isWorldHazard(attackerId) && !opposedShot) {
      return { applied: false, isDestroyed: false };
    }

    const existing = this.inputs.actors.getEntity(targetId);
    if (!existing) {
      return { applied: false, isDestroyed: false };
    }
    this.inputs.motion.releaseContourLock(existing.id, this.inputs.serverNow());
    if (
      existing.furnaceTransit ||
      (existing.shieldFrames ?? 0) > 0 ||
      isCombatantImmune(existing)
    ) {
      return { applied: false, isDestroyed: false };
    }

    if (!Number.isFinite(damage) || damage <= 0) {
      return { applied: false, isDestroyed: false };
    }
    this.inputs.rescue.cancel(existing.id);
    const healthBefore = existing.health;
    const spilled = Math.min(existing.cargo, Math.ceil(damage * ECONOMY.cargoPointsPerHp));
    if (spilled > 0) {
      existing.cargo -= spilled;
      this.spillCargo(existing, spilled);
      existing.healthRegenTimer = calculateHealthRegenDelayFrames();
      this.inputs.ledger.capture(existing.id);
    }
    const hullDamage = Math.max(0, damage - spilled / ECONOMY.cargoPointsPerHp);
    const damaged = this.inputs.actors.damageEntity(targetId, hullDamage);
    if (!damaged) {
      return { applied: false, isDestroyed: false };
    }

    if (damaged.health > 0) {
      if (damaged.health < healthBefore) {
        this.logState(damaged, attackerId, damage, healthBefore, 'survived');
      }
      return { applied: true, isDestroyed: false, entity: damaged };
    }

    if (this.inputs.campaign.activated && damaged.botRole === undefined) {
      this.inputs.rescue.down(damaged, attackerId);
    } else {
      this.inputs.terminalDeath(damaged, attackerId);
    }
    const finalDeath =
      damaged.downedUntil == null || damaged.downedUntil === 0 || Number.isNaN(damaged.downedUntil);
    this.logState(damaged, attackerId, damage, healthBefore, finalDeath ? 'destroyed' : 'downed');
    return { applied: true, isDestroyed: finalDeath, entity: damaged };
  }

  /**
   * A record for each hit that changes health, except an ordinary surviving hit
   * inside the one-second window. Only that case is throttled: a hit that ends
   * a life is the record `MessageHandler.applyBoundaryContact` suppresses the
   * motion-rejection warning in favour of, so it has to be written every time.
   * A hit a hold absorbs entirely changes no health and is not logged here at
   * all; for a wall contact the refused pose carries that record instead, under
   * its own throttle. A cooperative downing ends a life without destroying
   * the hull, and before it had its own event it was logged as a throttleable
   * `damage_applied` — which meant a wall death in cooperative play could leave
   * no record at all once the warning was suppressed.
   */
  private logState(
    entity: GameEntity,
    attackerId: string,
    damage: number,
    healthBefore: number,
    outcome: 'destroyed' | 'downed' | 'survived'
  ): void {
    const observedAt = Date.now();
    const throttleAt = this.inputs.serverNow();
    const lastThrottleAt = this.damageStateLogs.get(entity) ?? -Infinity;
    if (outcome === 'survived' && throttleAt - lastThrottleAt < 1000) {
      return;
    }
    this.damageStateLogs.set(entity, throttleAt);
    const event =
      outcome === 'destroyed'
        ? 'player_died'
        : outcome === 'downed'
          ? 'player_downed'
          : 'damage_applied';
    logger.info('STATE', event, {
      releaseId: SERVER_RELEASE_ID,
      playerId: entity.id,
      attackerId,
      source: 'collision',
      damage,
      observedAt,
      gameTime: this.inputs.currentFrame(),
      healthBefore,
      healthAfter: entity.health,

      state: captureDiagnosticActorState(entity),
    });
  }

  /** Recoverable hit spills launch beyond magnet range before collection resumes. */
  private spillCargo(entity: GameEntity, points: number): void {
    const count = Math.min(8, Math.max(1, Math.ceil(points / 100)));
    const base = Math.floor(points / count);
    for (let index = 0; index < count; index++) {
      const angle = entity.angle + (index / count) * Math.PI * 2;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const offset = hullRadiusForKit(entity.kitId) + GROWTH.LOOT_RADIUS + 10;
      this.inputs.loot.spawnPoints(
        { x: entity.position.x + dx * offset, y: entity.position.y + dy * offset },
        base + (index < points % count ? 1 : 0),
        {
          velocity: { x: dx * ECONOMY.cargoSpillSpeed, y: dy * ECONOMY.cargoSpillSpeed },
          ejectFramesLeft: ECONOMY.cargoSpillEjectFrames,
        }
      );
    }
  }
}
