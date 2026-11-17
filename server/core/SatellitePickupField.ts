import { SATELLITE_PICKUP } from '../../shared/constants/gameplay';
import { canCollectLoot } from '../../shared/shipGrowth';
import { hullRadiusForKit } from '../../shared/shipKits';
import type { SatellitePickupCollected } from '../../shared-types';
import type { EntityManager, GameEntity } from './EntityManager';
import type { SatellitePickupManager } from './SatellitePickupManager';

const MAX_PENDING_COLLECTIONS = 32;

type SatelliteFieldInputs = Readonly<{
  actors: Pick<EntityManager, 'getAllEntities'>;
  pickups: Pick<SatellitePickupManager, 'update' | 'getAllPickups' | 'collect'>;
  addCargo: (actor: GameEntity, points: number) => void;
  paused: () => boolean;
  now: () => number;
}>;

/** Advances human-owned hardware and resolves automatic collection and feedback. */
export class SatellitePickupField {
  private pendingCollections: SatellitePickupCollected[] = [];

  constructor(private readonly inputs: SatelliteFieldInputs) {}

  private humans(): GameEntity[] {
    return this.inputs.actors.getAllEntities().filter((actor) => actor.botRole === undefined);
  }

  advance(): void {
    if (this.inputs.paused()) {
      return;
    }
    const owners = this.humans().map((entity) => ({
      id: entity.id,
      position: entity.position,
      radius: hullRadiusForKit(entity.kitId),
      health: entity.health,
      exploding: entity.exploding,
    }));
    this.inputs.pickups.update(owners);
    this.collect();
  }

  private collect(): void {
    const players = this.humans()
      .filter(
        (entity) =>
          entity.health > 0 &&
          !entity.exploding &&
          entity.respawnTimer === undefined &&
          entity.overlayHold !== true
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    const loosePickups = this.inputs.pickups
      .getAllPickups()
      .filter((pickup) => pickup.state === 'loose' && pickup.health > 0)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const pickup of loosePickups) {
      const collector = players
        .filter((entity) => canCollectLoot(entity))
        .map((entity) => ({
          entity,
          distance: Math.hypot(
            pickup.position.x - entity.position.x,
            pickup.position.y - entity.position.y
          ),
        }))
        .filter(({ distance }) => distance <= SATELLITE_PICKUP.AUTO_COLLECT_RANGE)
        .sort(
          (a, b) => a.distance - b.distance || a.entity.id.localeCompare(b.entity.id)
        )[0]?.entity;
      if (!collector) {
        continue;
      }

      const collected = this.inputs.pickups.collect(pickup.id, {
        id: collector.id,
        position: collector.position,
        radius: hullRadiusForKit(collector.kitId),
        health: collector.health,
        exploding: collector.exploding,
      });
      if (!collected) {
        continue;
      }

      this.inputs.addCargo(collector, SATELLITE_PICKUP.SCORE_BONUS);
      collector.lastUpdate = this.inputs.now();
      this.queueCollected({
        position: { ...pickup.position },
        pickupId: collected.id,
        playerId: collector.id,
        playerName: collector.name,
        pickupName: collected.name,
        scoreBonus: SATELLITE_PICKUP.SCORE_BONUS,
      });
    }
  }

  private queueCollected(event: SatellitePickupCollected): void {
    if (this.pendingCollections.length >= MAX_PENDING_COLLECTIONS) {
      this.pendingCollections.shift();
    }
    this.pendingCollections.push(event);
  }

  public drainCollections(): SatellitePickupCollected[] {
    const events = this.pendingCollections;
    this.pendingCollections = [];
    return events;
  }

  /** Missed collection notifications do not survive a pause or world reset. */
  clearPendingFeedback(): void {
    this.pendingCollections = [];
  }
}
