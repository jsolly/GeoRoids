import { COOPERATIVE } from '../../shared/cooperativeRules';
import { oreResource } from '../../shared/economy';
import { frontierSite } from '../../shared/frontier';
import type { FurnaceField } from '../../shared/furnaceField';
import { civicLot, furnaceReward, TOWN_HEARTH } from '../../shared/furnaces';
import { isTowCableUtility } from '../../shared/shipUtilities';
import { attachTowCable } from '../../shared/towCable';
import type { AsteroidData, MapAsset, Position } from '../../shared-types';
import type { CooperativeCampaign } from '../world/CooperativeCampaign';
import type { GameEntity } from './EntityManager';
import type { ServerClock } from './ServerClock';

interface SupplyRestorationPorts {
  campaign: Pick<CooperativeCampaign, 'activated' | 'all' | 'get' | 'set'>;
  furnaces: Pick<FurnaceField, 'intakeAt' | 'isLit' | 'replaceFrontier'>;
  clock: Pick<ServerClock, 'now'>;
  insertAsteroid: (rock: AsteroidData) => void;
  revealArea: (position: Position, range: number) => void;
}

/** Physical stock, shipment issuance and the cleared-ruin commissioning transition. */
export class CooperativeSupplyRestoration {
  private readonly commissioned = new Set<string>();

  constructor(private readonly ports: SupplyRestorationPorts) {
    for (const row of ports.campaign.all()) {
      if (row.kind === 'hive' && row.commissionedAt !== null) {
        this.commissioned.add(row.id);
      }
    }
    ports.furnaces.replaceFrontier(this.commissionedIds());
  }

  commissionedIds(): string[] {
    return [...this.commissioned];
  }

  furnaceMapAssets(): MapAsset[] {
    return this.commissionedIds().flatMap((id) => {
      const site = frontierSite(id);
      return site
        ? [{ id, kind: 'furnace' as const, name: site.name, position: site.position }]
        : [];
    });
  }

  reset(): void {
    this.commissioned.clear();
    this.ports.furnaces.replaceFrontier([]);
  }

  permitsDelivery(rock: AsteroidData, destinationId: string): boolean {
    if (!rock.supply) {
      return !destinationId.startsWith('frontier:') || this.ports.furnaces.isLit(destinationId);
    }
    if (!destinationId.startsWith('frontier:')) {
      return false;
    }
    const site = frontierSite(destinationId);
    const source = rock.supply
      ? (frontierSite(rock.supply.sourceId) ??
        civicLot(rock.supply.sourceId) ??
        (rock.supply.sourceId === TOWN_HEARTH.id ? TOWN_HEARTH : undefined))
      : undefined;
    return Boolean(
      site &&
        source &&
        rock.supply &&
        this.ports.furnaces.isLit(source.id) &&
        source.id !== site.id &&
        Math.hypot(source.position.x, source.position.y) <
          Math.hypot(site.position.x, site.position.y)
    );
  }

  withdraw(actor: GameEntity): boolean {
    if (
      actor.health <= 0 ||
      actor.exploding ||
      actor.overlayHold === true ||
      actor.rescue ||
      actor.kitId !== 'hauler' ||
      !isTowCableUtility(actor) ||
      (actor.harpoonTargetId != null && actor.harpoonTargetId !== '')
    ) {
      return false;
    }
    const source = this.ports.furnaces.intakeAt(actor.position);
    const ledger = source ? this.ports.campaign.get('supply', source.id) : undefined;
    if (!source || ledger == null || ledger.availableValue <= 0) {
      return false;
    }
    const value = Math.min(COOPERATIVE.shipmentValue, ledger.availableValue);
    const id = `supply:${source.id}:${ledger.nextShipment}`;
    const position = { x: source.position.x + source.radius + 55, y: source.position.y };
    const shipment: AsteroidData = {
      id,
      position,
      velocity: { x: 0, y: 0 },
      size: 35,
      jaggedness: 0,
      rotation: 0,
      angularVelocity: 0,
      health: 100,
      maxHealth: 100,
      vertices: 6,
      offsets: [1, 1, 1, 1, 1, 1],
      material: 'metal',
      ore: null,
      supply: { sourceId: source.id, value },
    };
    this.ports.insertAsteroid(shipment);

    this.ports.campaign.set({
      ...ledger,
      availableValue: ledger.availableValue - value,
      nextShipment: ledger.nextShipment + 1,
    });
    actor.harpoonTargetId = id;
    actor.harpoonLatchPos = { ...position };
    attachTowCable(actor, shipment);
    return true;
  }

  recordDelivery(rock: AsteroidData, destinationId: string, contributors: readonly string[]): void {
    if (!this.ports.campaign.activated) {
      return;
    }
    let value = rock.supply?.value ?? (oreResource(rock) ? furnaceReward(rock) : 0);
    if (value <= 0) {
      return;
    }
    if (destinationId === TOWN_HEARTH.id) {
      const project = this.ports.campaign.get('project', 'deep-scanner') ?? {
        kind: 'project' as const,
        id: 'deep-scanner' as const,
        deliveredValue: 0,
        completedAt: null,
      };
      const accepted = Math.min(value, COOPERATIVE.scannerValue - project.deliveredValue);
      value -= accepted;
      const deliveredValue = project.deliveredValue + accepted;
      this.ports.campaign.set({
        ...project,
        deliveredValue,
        completedAt:
          deliveredValue === COOPERATIVE.scannerValue
            ? (project.completedAt ?? Math.floor(this.ports.clock.now()))
            : null,
      });
    }
    const hive = this.ports.campaign.get('hive', destinationId);
    if (hive != null && hive.clearedAt !== null && hive.commissionedAt === null) {
      const accepted = Math.min(value, COOPERATIVE.restoreValue - hive.restoredValue);
      value -= accepted;
      hive.restoredValue += accepted;
      hive.contributors = [
        ...new Set([...hive.contributors, ...contributors, ...(rock.surveyedBy ?? [])]),
      ];
      if (hive.restoredValue === COOPERATIVE.restoreValue) {
        hive.commissionedAt = Math.floor(this.ports.clock.now());
        this.commissioned.add(hive.id);
        this.ports.furnaces.replaceFrontier(this.commissionedIds());
        this.ports.revealArea(hive.position, COOPERATIVE.atlasRadius);
      }
      this.ports.campaign.set(hive);
    }
    if (value > 0) {
      const ledger = this.ports.campaign.get('supply', destinationId) ?? {
        kind: 'supply' as const,
        id: destinationId,
        availableValue: 0,
        nextShipment: 0,
      };
      this.ports.campaign.set({ ...ledger, availableValue: ledger.availableValue + value });
    }
  }
}
