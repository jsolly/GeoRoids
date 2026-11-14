import { boostOwnerIds } from '../../shared/asteroidBoost';
import { oreResource, oreYield } from '../../shared/economy';
import { furnaceReward } from '../../shared/furnaces';
import { clearHaulerLatch } from '../../shared/shipAbilities';
import { SHIP_ABILITY } from '../../shared/shipKits';
import { isTowCableUtility } from '../../shared/shipUtilities';
import type { AsteroidData, FurnaceDelivery, Position } from '../../shared-types';
import type { FurnaceDeliveryInputs } from './types';

/** Physical intake, contributor awards, attachment release and public delivery feedback. */
export class FurnaceDeliveryManager {
  private readonly pendingDeliveries: FurnaceDelivery[] = [];
  constructor(private readonly inputs: FurnaceDeliveryInputs) {}

  private towCrewOf(asteroidId: string): string[] {
    const ids: string[] = [];
    for (const entity of this.inputs.actors.getAllEntities()) {
      if (
        isTowCableUtility(entity) &&
        entity.harpoonTargetId === asteroidId &&
        !entity.exploding &&
        entity.health > 0 &&
        entity.respawnTimer === undefined
      ) {
        ids.push(entity.id);
      }
    }
    return ids;
  }

  private deliveryFurnaceAt(position: Position) {
    return (
      this.inputs.furnaces.intakeAt(position) ??
      this.inputs.hives
        .ruinsNear(position)
        .find(
          (site) =>
            Math.hypot(position.x - site.position.x, position.y - site.position.y) <= site.radius
        )
    );
  }

  /** Furnace intake accepts towed or self-guided cargo once; loose rocks remain. */
  advance(): void {
    const deliveries: FurnaceDelivery[] = [];
    for (const hauler of this.inputs.actors.getAllEntities()) {
      if (
        hauler.kitId !== 'hauler' ||
        !isTowCableUtility(hauler) ||
        hauler.harpoonTargetId == null ||
        hauler.harpoonTargetId === '' ||
        hauler.exploding ||
        hauler.health <= 0 ||
        hauler.respawnTimer !== undefined
      ) {
        continue;
      }
      const rock = this.inputs.rocks.getAsteroid(hauler.harpoonTargetId);
      if (!rock || rock.health <= 0) {
        continue;
      }
      const furnace = this.deliveryFurnaceAt(rock.position);
      if (
        !furnace ||
        Math.hypot(hauler.position.x - furnace.position.x, hauler.position.y - furnace.position.y) >
          furnace.radius + SHIP_ABILITY.HARPOON_RANGE * SHIP_ABILITY.HARPOON_SLACK
      ) {
        continue;
      }
      if (this.inputs.supply.permitsDelivery(rock, furnace.id)) {
        deliveries.push(this.deliverAsteroid(rock, furnace, this.towCrewOf(rock.id)));
      }
    }
    for (const rock of this.inputs.rocks.boostedAsteroids()) {
      if (rock.health <= 0 || rock.boost?.phase !== 'burning') {
        continue;
      }
      const furnace = this.deliveryFurnaceAt(rock.position);
      if (furnace && this.inputs.supply.permitsDelivery(rock, furnace.id)) {
        deliveries.push(this.deliverAsteroid(rock, furnace, boostOwnerIds(rock.boost)));
      }
    }
    this.pendingDeliveries.push(...deliveries);
  }

  private deliverAsteroid(
    rock: AsteroidData,
    furnace: { id: string; position: Position },
    ownerIds: readonly string[]
  ): FurnaceDelivery {
    this.inputs.lifecycle.remove(rock.id);
    this.inputs.supply.recordDelivery(rock, furnace.id, ownerIds);
    const launchers = new Set(ownerIds);
    const recipients = new Set([...launchers, ...(rock.surveyedBy ?? [])]);
    const resource = oreResource(rock);
    this.inputs.settlement.addOre(resource, resource ? oreYield(rock) : 0);
    const points = rock.supply ? 0 : furnaceReward(rock);
    const rewards: FurnaceDelivery['rewards'] = [];
    for (const playerId of recipients) {
      const player = this.inputs.actors.getEntity(playerId);
      if (this.inputs.awardPilotPoints(playerId, points) === undefined) {
        continue;
      }
      rewards.push({
        playerId,
        playerName: player?.name ?? this.inputs.savedPilotName(playerId) ?? '',
        points,
      });
    }
    this.releaseTowsAttachedTo(rock.id);
    return {
      furnaceId: furnace.id,
      asteroidId: rock.id,
      position: { ...furnace.position },
      material: rock.material ?? 'rubble',
      rewards,
    };
  }

  drainDeliveries(): FurnaceDelivery[] {
    return this.pendingDeliveries.splice(0);
  }

  releaseTowsAttachedTo(asteroidId: string): void {
    for (const player of this.inputs.actors.getAllEntities()) {
      if (player.harpoonTargetId === asteroidId) {
        clearHaulerLatch(player);
      }
    }
  }

  /** Retire missed feedback without changing earned state. */
  clearPendingFeedback(): void {
    this.pendingDeliveries.length = 0;
  }
}
