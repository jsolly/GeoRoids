import { asteroidShardMass } from '../../shared/asteroidMaterials';
import { pointsForRoidSize } from '../../shared/asteroidScale';
import { DAMAGE } from '../../shared/constants/gameplay';
import { EQUIPMENT_DROPS, EQUIPMENT_IDS } from '../../shared/equipment';
import { SHIP_ABILITY } from '../../shared/shipKits';
import type { AsteroidHitCause, AsteroidHitOutcome } from './AsteroidManager';
import type { AppliedAsteroidHit, AsteroidMiningInputs } from './types';

/** Owns authoritative mining damage and the consequences of an asteroid hit. */
export class AsteroidMining {
  constructor(private readonly inputs: AsteroidMiningInputs) {}

  damageFor(playerId: string): number {
    const kitId = this.inputs.actors.getEntity(playerId)?.kitId;
    return DAMAGE.LASER_HIT * (kitId === 'hauler' ? SHIP_ABILITY.ASTEROID_DAMAGE_MULTIPLIER : 1);
  }

  hit(
    asteroidId: string,
    playerId: string,
    cause: AsteroidHitCause = 'laser',
    miningDamage = this.damageFor(playerId)
  ): AsteroidHitOutcome {
    const result =
      cause === 'collision'
        ? this.inputs.rocks.destroyFromCollision(asteroidId)
        : this.inputs.rocks.registerLaserHit(asteroidId, playerId, miningDamage);

    if (result.outcome === 'destroyed') {
      this.inputs.deliveries.releaseTowsAttachedTo(asteroidId);
      if (cause === 'laser' && result.destroyed.contourRider) {
        this.inputs.loot.spawnTap(
          result.destroyed.position,
          this.inputs.currentFrame(),
          { x: 0, y: 0 },
          'crystal'
        );
      }
      const points = pointsForRoidSize(result.destroyed.size);
      this.inputs.loot.spawnPoints(result.destroyed.position, points);
      const shardMass = asteroidShardMass(result.destroyed.material);
      this.inputs.loot.spawnShard(result.destroyed.position, this.inputs.currentFrame(), shardMass);
      if (cause === 'laser' && this.inputs.rng.random() < EQUIPMENT_DROPS.ASTEROID_CHANCE) {
        const equipment =
          EQUIPMENT_IDS[Math.floor(this.inputs.rng.random() * EQUIPMENT_IDS.length)];
        if (equipment) {
          this.inputs.loot.spawnEquipment(
            result.destroyed.position,
            this.inputs.currentFrame(),
            equipment
          );
        }
      }
    }
    return result;
  }

  /** Applied outcome for ordinary mining and ram hits. */
  apply(
    asteroidId: string,
    playerId: string,
    cause: AsteroidHitCause = 'laser',
    miningDamage = this.damageFor(playerId)
  ): AppliedAsteroidHit {
    const empty: AppliedAsteroidHit = {
      applied: false,
      outcome: 'missing',
      asteroidId,
      playerId,
      points: 0,
      newAsteroids: [],
    };

    const asteroid = this.inputs.rocks.getAsteroid(asteroidId);
    if (!asteroid) {
      return empty;
    }

    const result = this.hit(asteroidId, playerId, cause, miningDamage);
    if (result.outcome === 'missing' || result.outcome === 'ignored') {
      return { ...empty, outcome: result.outcome };
    }

    const origin = result.outcome === 'destroyed' ? result.destroyed.position : asteroid.position;

    return {
      applied: true,
      outcome: result.outcome,
      asteroidId,
      playerId,
      points: result.outcome === 'destroyed' ? pointsForRoidSize(result.destroyed.size) : 0,
      newAsteroids: result.newAsteroids,
      origin,
    };
  }
}
