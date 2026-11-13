import { boostOwnerIds, removeBoostOwner } from '../../shared/asteroidBoost';
import { asteroidCrewNeeded } from '../../shared/asteroidScale';
import { SATELLITE_PICKUP } from '../../shared/constants/gameplay';
import { EXPLORATION_RANGE } from '../../shared/exploration';
import { clearHaulerLatch, pullHarpoonTarget, tickTapExtract } from '../../shared/shipAbilities';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { haulerUtilityOf, isTowCableUtility } from '../../shared/shipUtilities';
import type { AsteroidData, Position, TapEjected, Velocity } from '../../shared-types';
import type { AsteroidManager } from './AsteroidManager';
import type { EntityManager } from './EntityManager';
import type { HiveEncounters } from './HiveEncounters';
import type { LootManager } from './LootManager';
import type { SatellitePickupManager } from './SatellitePickupManager';
import type { TerrainSpiderManager } from './TerrainSpiderManager';

interface ShipAbilityInputs {
  actors: Pick<EntityManager, 'tickAbilityState' | 'getAllEntities' | 'getEntity'>;
  rocks: Pick<AsteroidManager, 'spatialIndex' | 'getAsteroid' | 'boostedAsteroids'>;
  pickups: Pick<SatellitePickupManager, 'countOrbitingFor'>;
  spiders: Pick<TerrainSpiderManager, 'getBody' | 'extractSilk'>;
  hives: Pick<HiveEncounters, 'body'>;
  loot: Pick<LootManager, 'spawnSilk' | 'spawnTap'>;
  frame: () => number;
  revealArea: (position: Position, range: number) => void;
  maximumPendingEjections: number;
}

function tapLootEjection(
  ship: Position,
  rock: Pick<AsteroidData, 'position' | 'size'>,
  burst: number
): { position: Position; velocity: Velocity } {
  const angle =
    Math.atan2(rock.position.y - ship.y, rock.position.x - ship.x) +
    (burst / (SHIP_ABILITY.TAP_EXTRACT_BURSTS - 1) - 0.5) * 1.4;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  return {
    position: {
      x: rock.position.x + dx * rock.size,
      y: rock.position.y + dy * rock.size,
    },
    velocity: { x: dx * 3, y: dy * 3 },
  };
}

export function markSurveyedAsteroids(
  ownerId: string,
  position: Position,
  asteroids: readonly AsteroidData[],
  range: number
): void {
  for (const rock of asteroids) {
    if (
      rock.health <= 0 ||
      rock.boost?.phase === 'burning' ||
      Math.hypot(rock.position.x - position.x, rock.position.y - position.y) > range
    ) {
      continue;
    }
    rock.surveyedBy ??= [];
    if (!rock.surveyedBy.includes(ownerId)) {
      rock.surveyedBy.push(ownerId);
    }
  }
}

/** Advances ship utilities and owns their bounded, transient tap feedback. */
export class ShipAbilityManager {
  private pendingTapEjections: TapEjected[] = [];

  constructor(private readonly inputs: ShipAbilityInputs) {}

  advance(): void {
    this.inputs.actors.tickAbilityState();
    const frame = this.inputs.frame();
    const towCrew = new Map<string, number>();
    for (const actor of this.inputs.actors.getAllEntities()) {
      if (
        isTowCableUtility(actor) &&
        actor.harpoonTargetId != null &&
        actor.harpoonTargetId !== '' &&
        !actor.exploding &&
        actor.health > 0 &&
        actor.respawnTimer === undefined
      ) {
        towCrew.set(actor.harpoonTargetId, (towCrew.get(actor.harpoonTargetId) ?? 0) + 1);
      }
    }
    for (const entity of this.inputs.actors.getAllEntities()) {
      entity.contourDraftFrames = Math.max(0, (entity.contourDraftFrames ?? 0) - 1);
      entity.navigationAssistFrames = Math.max(0, (entity.navigationAssistFrames ?? 0) - 1);
      const scanRange =
        entity.kitId === 'scout' && entity.abilityActiveFrames > 0
          ? SHIP_ABILITY.SCAN_RANGE
          : this.inputs.pickups.countOrbitingFor(entity.id) > 0
            ? SATELLITE_PICKUP.SCAN_RANGE
            : 0;
      if (!entity.exploding && entity.health > 0 && entity.respawnTimer === undefined) {
        this.inputs.revealArea(
          entity.position,
          Math.max(EXPLORATION_RANGE[entity.kitId], scanRange)
        );
        if (scanRange > 0) {
          const nearbyAsteroids = this.inputs.rocks.spatialIndex().query({
            minX: entity.position.x - scanRange,
            minY: entity.position.y - scanRange,
            maxX: entity.position.x + scanRange,
            maxY: entity.position.y + scanRange,
          });
          markSurveyedAsteroids(entity.id, entity.position, nearbyAsteroids, scanRange);
        }
      }
      const spider =
        entity.harpoonTargetId != null && entity.harpoonTargetId !== ''
          ? this.inputs.spiders.getBody(entity.harpoonTargetId)
          : undefined;
      const target =
        entity.harpoonTargetId != null && entity.harpoonTargetId !== ''
          ? (this.inputs.rocks.getAsteroid(entity.harpoonTargetId) ??
            spider ??
            (isTowCableUtility(entity)
              ? this.inputs.hives.body(entity.harpoonTargetId)
              : undefined))
          : undefined;
      if (target && 'boost' in target && target.boost?.phase === 'burning') {
        clearHaulerLatch(entity);
        continue;
      }
      if (target && 'contourRider' in target && isTowCableUtility(entity)) {
        target.contourRider = null;
      }
      pullHarpoonTarget(
        entity,
        target ? [target] : [],
        target !== undefined &&
          !target.id.startsWith('frontier:') &&
          (towCrew.get(target.id) ?? 0) >= asteroidCrewNeeded(target.size ?? 0)
      );
      const extract = tickTapExtract(entity, target);
      if ((extract === 'burst' || extract === 'complete') && target) {
        const burst =
          Math.floor(
            ((entity.tapExtractFrames ?? 0) * SHIP_ABILITY.TAP_EXTRACT_BURSTS) /
              SHIP_ABILITY.TAP_EXTRACT_FRAMES
          ) - 1;
        const ejection = tapLootEjection(
          entity.position,
          { position: target.position, size: target.size ?? 0 },
          burst
        );
        const hasSilk = !spider || this.inputs.spiders.extractSilk(spider.id, entity.id);
        if (!hasSilk) {
          clearHaulerLatch(entity);
          continue;
        }
        const drop = spider
          ? this.inputs.loot.spawnSilk(ejection.position, frame, ejection.velocity)
          : this.inputs.loot.spawnTap(
              ejection.position,
              frame,
              ejection.velocity,
              'material' in target ? target.material : undefined
            );
        if (this.pendingTapEjections.length >= this.inputs.maximumPendingEjections) {
          this.pendingTapEjections.shift();
        }
        this.pendingTapEjections.push({ lootId: drop.id, position: { ...drop.position } });
        if (extract === 'complete') {
          clearHaulerLatch(entity);
        }
      }
    }
    for (const rock of this.inputs.rocks.boostedAsteroids()) {
      if (rock.boost?.phase !== 'armed') {
        continue;
      }
      for (const ownerId of boostOwnerIds(rock.boost)) {
        const owner = this.inputs.actors.getEntity(ownerId);
        if (
          !owner ||
          owner.exploding ||
          owner.health <= 0 ||
          owner.harpoonTargetId !== rock.id ||
          haulerUtilityOf(owner) !== 'boost_coupling'
        ) {
          rock.boost = removeBoostOwner(rock.boost, ownerId);
          if (!rock.boost) {
            break;
          }
        }
      }
    }
  }

  drainTapEjections(): TapEjected[] {
    return this.pendingTapEjections.splice(0);
  }

  clearPendingFeedback(): void {
    this.pendingTapEjections = [];
  }
}
