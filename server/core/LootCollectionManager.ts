import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import { isEquipmentId } from '../../shared/equipment';
import { NAVIGATION_SALVAGE } from '../../shared/navigationSalvage';
import type { LootCollected } from '../../shared-types';
import type { EntityManager } from './EntityManager';
import type { LootManager } from './LootManager';

interface LootCollectionInputs {
  actors: Pick<EntityManager, 'getAllEntities'>;
  loot: Pick<LootManager, 'expire' | 'collectOverlaps'>;
  now: () => number;
  capturePilot: (id: string) => void;
  maximumPendingCollections: number;
}

/** Applies collection effects and owns their transient, bounded feedback. */
export class LootCollectionManager {
  private pendingLootCollections: LootCollected[] = [];

  constructor(private readonly inputs: LootCollectionInputs) {}

  advance(frame: number): void {
    this.inputs.loot.expire(frame, this.inputs.actors.getAllEntities());
    this.collect();
  }

  /** Server-authoritative pickup: first overlapping live ship wins. */
  collect(): void {
    const collected = this.inputs.loot.collectOverlaps(this.inputs.actors.getAllEntities());
    const events: LootCollected[] = [];
    for (const { collector, loot } of collected) {
      events.push({
        eventId: randomUUID(),
        lootId: loot.id,
        collectorId: collector.id,
        kind: loot.kind,
        position: { ...loot.position },
      });
      if (isEquipmentId(loot.kind)) {
        collector.equipment = [...(collector.equipment ?? []), loot.kind];
        collector.lastUpdate = this.inputs.now();
        this.inputs.capturePilot(collector.id);
        continue;
      }
      if ((loot.points ?? 0) > 0) {
        this.inputs.capturePilot(collector.id);
        continue;
      }
      if (loot.salvage === 'ice') {
        collector.health = Math.min(
          collector.maxHealth,
          collector.health + NAVIGATION_SALVAGE.iceRepair
        );
      }
      if (loot.salvage === 'crystal') {
        collector.navigationAssistFrames = NAVIGATION_SALVAGE.frames;
      }
      if (loot.kind === 'silk' || loot.salvage === 'rubble') {
        collector.silk = (collector.silk ?? 0) + 1;
        collector.lastUpdate = this.inputs.now();
        this.inputs.capturePilot(collector.id);
        continue;
      }
      collector.lastUpdate = this.inputs.now();
      logger.debug('LOOT', 'Collected loot', {
        collectorId: collector.id,
        lootId: loot.id,
        kind: loot.kind,
        mass: collector.mass,
        maxHealth: collector.maxHealth,
      });
    }
    for (const event of events) {
      if (this.pendingLootCollections.length >= this.inputs.maximumPendingCollections) {
        this.pendingLootCollections.shift();
      }
      this.pendingLootCollections.push(event);
    }
  }

  drainCollections(): LootCollected[] {
    return this.pendingLootCollections.splice(0);
  }

  clearPendingFeedback(): void {
    this.pendingLootCollections = [];
  }
}
