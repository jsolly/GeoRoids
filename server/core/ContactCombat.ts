import { checkBoundaryCollision } from '../../shared/boundary';
import { DAMAGE } from '../../shared/constants/gameplay';
import { hullRadiusForKit } from '../../shared/shipKits';
import { isTowCableUtility } from '../../shared/shipUtilities';
import type { AsteroidData } from '../../shared-types';
import { separateShipFromAsteroid } from './CollisionAuthority';
import type { GameEntity } from './EntityManager';
import type { AppliedAsteroidHit, CombatBroadcast, CombatSink, ContactCombatInputs } from './types';

/** Owns authoritative hull contacts, towed-rock impacts and combat result delivery. */
export class ContactCombat {
  private combatSink: CombatSink | null = null;

  constructor(private readonly inputs: ContactCombatInputs) {}

  public setSink(sink: CombatSink | null): void {
    this.combatSink = sink;
  }

  public emit(result: CombatBroadcast): void {
    this.combatSink?.(result);
  }

  /**
   * Server-owned ship and asteroid resolution. Asteroid motion already ran in
   * the game loop (`updateMotion`); this only applies health. Ram uses the tip
   * collision destroy path independently of mining damage.
   */
  public advance(): CombatBroadcast[] {
    if (this.inputs.paused()) {
      return [];
    }

    const results: CombatBroadcast[] = [];
    const entities = this.inputs.actors.getAllEntities();
    for (const entity of entities) {
      const radius = hullRadiusForKit(entity.kitId);
      if (checkBoundaryCollision(entity.position, radius)) {
        const result = this.directedHit(entity.id, 'boundary', entity.health);
        if (result) {
          results.push(result);
        }
      }
    }

    const pickupBodyHits = this.inputs.collisions.collectAsteroidPickupHits(
      this.inputs.rocks.spatialIndex(),
      this.inputs.pickups.getAllPickups()
    );
    for (const hit of pickupBodyHits) {
      this.inputs.pickups.damage(hit.pickupId, DAMAGE.LASER_HIT);
    }

    const ramHits = this.inputs.collisions.collectShipAsteroidHits(
      entities,
      this.inputs.rocks.spatialIndex(),
      (shipId, rock) =>
        rock.boost?.phase !== 'burning' && !this.isActiveHarpoonTarget(shipId, rock.id)
    );
    const destroyedAsteroids = new Set<string>();
    const bumperKeys = this.resolveTowedAsteroidImpacts(entities, destroyedAsteroids);
    for (const hit of ramHits) {
      this.inputs.motion.releaseContourLock(hit.shipId, this.inputs.serverNow());
      if (bumperKeys.has(`${hit.shipId}:${hit.asteroidId}`)) {
        continue;
      }
      const result = this.directedHit(hit.shipId, 'asteroid', DAMAGE.ASTEROID_COLLISION);
      if (!result) {
        continue;
      }
      if (!destroyedAsteroids.has(hit.asteroidId)) {
        const destruction = this.inputs.mining.hit(hit.asteroidId, hit.shipId, 'collision');
        if (destruction.outcome === 'destroyed') {
          destroyedAsteroids.add(hit.asteroidId);
          result.destroyedAsteroidId = hit.asteroidId;
          result.newAsteroids = destruction.newAsteroids;
          result.origin = destruction.destroyed.position;
        }
      }
      const remaining = this.inputs.rocks.getAsteroid(hit.asteroidId);
      const rammed = this.inputs.actors.getEntity(hit.shipId);
      if (remaining && rammed) {
        separateShipFromAsteroid(rammed, hullRadiusForKit(rammed.kitId), remaining);
        this.inputs.motion.applyExternalImpulse(rammed.id, this.inputs.serverNow());
      }
      results.push(result);
    }

    for (const attack of this.inputs.spiders.drainAttacks()) {
      if (!this.inputs.spiders.isAttackActive(attack)) {
        continue;
      }
      const target = this.inputs.actors.getEntity(attack.targetId);
      if (!target) {
        continue;
      }
      const result = this.directedHit(attack.targetId, attack.attackerId, target.health);
      if (result) {
        results.push(result);
      }
    }

    for (const result of results) {
      this.emit(result);
    }
    return results;
  }

  /** An active Hauler harpoon lets its owner pass through that exact rock. */
  private isActiveHarpoonTarget(shipId: string, asteroidId: string): boolean {
    const ship = this.inputs.actors.getEntity(shipId);
    return ship?.kitId === 'hauler' && ship.harpoonTargetId === asteroidId;
  }

  /**
   * Towed cargo that overlaps another rock uses the ordinary collision break
   * on both bodies and drops the cable. The Hauler is not rammed by a rock
   * its cargo is already breaking this frame.
   */
  private resolveTowedAsteroidImpacts(
    entities: GameEntity[],
    destroyedAsteroids: Set<string>
  ): Set<string> {
    const towedOwners = new Map<string, string[]>();
    const towedRocks: AsteroidData[] = [];
    for (const entity of entities) {
      if (
        entity.kitId !== 'hauler' ||
        !isTowCableUtility(entity) ||
        entity.harpoonTargetId == null ||
        entity.harpoonTargetId === ''
      ) {
        continue;
      }
      const rock = this.inputs.rocks.getAsteroid(entity.harpoonTargetId);
      if (!rock || rock.health <= 0) {
        continue;
      }
      const owners = towedOwners.get(rock.id);
      if (owners) {
        owners.push(entity.id);
      } else {
        towedOwners.set(rock.id, [entity.id]);
        towedRocks.push(rock);
      }
    }
    const bumperKeys = new Set<string>();
    const cargoBreaks: AppliedAsteroidHit[] = [];
    for (const hit of this.inputs.collisions.collectTowedAsteroidHits(
      towedRocks,
      this.inputs.rocks.spatialIndex(),
      (rock) => rock.boost?.phase !== 'burning'
    )) {
      const haulerIds = towedOwners.get(hit.towedId);
      if (haulerIds?.length == null || haulerIds?.length === 0 || Number.isNaN(haulerIds?.length)) {
        continue;
      }
      for (const haulerId of haulerIds) {
        bumperKeys.add(`${haulerId}:${hit.otherId}`);
      }
      for (const otherHaulerId of towedOwners.get(hit.otherId) ?? []) {
        bumperKeys.add(`${otherHaulerId}:${hit.towedId}`);
      }
      const scorerId = haulerIds[0];
      if (scorerId == null || scorerId === '') {
        continue;
      }
      for (const asteroidId of [hit.towedId, hit.otherId]) {
        if (destroyedAsteroids.has(asteroidId)) {
          continue;
        }
        const applied = this.inputs.mining.apply(asteroidId, scorerId, 'collision');
        if (!applied.applied || applied.outcome !== 'destroyed') {
          continue;
        }
        destroyedAsteroids.add(asteroidId);
        cargoBreaks.push(applied);
      }
    }
    this.inputs.emitAsteroidHits(cargoBreaks);
    return bumperKeys;
  }

  public directedHit(targetId: string, attackerId: string, damage: number): CombatBroadcast | null {
    const outcome = this.inputs.damage.apply(targetId, attackerId, damage);
    if (!outcome.applied) {
      return null;
    }
    const broadcast: CombatBroadcast = {
      targetId,
      attackerId,
      damage,
      remainingHealth: outcome.entity.health,

      isDestroyed: outcome.isDestroyed,
      targetType: outcome.entity.type,
    };
    return broadcast;
  }
}
