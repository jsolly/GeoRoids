import { FURNACE_BUILD } from '../../shared/furnaceField';
import { civicLot, civicLotAt, civicModuleName, TOWN_HEARTH } from '../../shared/furnaces';
import { sanitizePlayerName } from '../../shared/player';
import { insideTownStore, storeOffer, TOWN_STORE_ISSUE } from '../../shared/townStore';
import type { GameEntity } from './EntityManager';
import type { CivicTransactionsInputs } from './types';

/** Authoritative furnace construction and placeholder purchases, with their transaction notices. */
export class CivicTransactions {
  private lastFurnaceBuildNotice = '';

  constructor(private readonly inputs: CivicTransactionsInputs) {}

  public buildIssue(entityId: string): string | undefined {
    const scout = this.inputs.actors.getEntity(entityId);
    if (
      scout?.kitId !== 'scout' ||
      scout.exploding ||
      scout.health <= 0 ||
      scout.furnaceTransit ||
      scout.respawnTimer !== undefined
    ) {
      return FURNACE_BUILD.ISSUE.READY;
    }
    const lot = civicLotAt(scout.position);
    if (!lot) {
      return FURNACE_BUILD.ISSUE.STAND;
    }
    if (this.inputs.furnaces.isLit(lot.id)) {
      return FURNACE_BUILD.ISSUE.LIT;
    }
    if (lot.parentId !== TOWN_HEARTH.id && !this.inputs.furnaces.isLit(lot.parentId)) {
      const parent = civicLot(lot.parentId);
      return parent
        ? `Light ${this.inputs.furnaces.displayName(parent.id)} first`
        : 'Light the inward furnace first';
    }
    const score = Number.isSafeInteger(scout.score) ? scout.score : 0;
    if (score < lot.cost) {
      const remaining = lot.cost - Math.max(0, score);
      return `You need ${remaining} more ${remaining === 1 ? 'point' : 'points'} to build this furnace`;
    }
    return undefined;
  }

  public buildNotice(): string {
    return this.lastFurnaceBuildNotice;
  }

  public buy(entityId: string, offerId: string): string | undefined {
    const offer = storeOffer(offerId);
    const pilot = this.inputs.actors.getEntity(entityId);
    if (
      !offer ||
      !pilot ||
      pilot.furnaceTransit ||
      this.inputs.paused() ||
      pilot.health <= 0 ||
      pilot.exploding ||
      pilot.respawnTimer !== undefined
    ) {
      return TOWN_STORE_ISSUE.CLOSED;
    }
    if (!insideTownStore(pilot.position)) {
      return TOWN_STORE_ISSUE.AWAY;
    }
    if (pilot.purchases.includes(offer.id)) {
      return 'Already purchased. This placeholder grants no upgrade.';
    }
    if (this.inputs.settlement.current().level < offer.level) {
      return `Requires settlement level ${offer.level}`;
    }
    if (pilot.score < offer.cost) {
      return `You need ${offer.cost - pilot.score} more banked points`;
    }
    pilot.score -= offer.cost;
    pilot.purchases.push(offer.id);
    this.inputs.ledger.capture(pilot.id);
    return undefined;
  }

  public storeNotice(offerId: string): string {
    return `${storeOffer(offerId)?.name ?? 'Placeholder'} purchased. No upgrade granted.`;
  }

  public build(scout: GameEntity): boolean {
    const furnaceIssue = this.buildIssue(scout.id);
    if (furnaceIssue != null && furnaceIssue !== '') {
      return false;
    }
    const lot = civicLotAt(scout.position);
    if (!lot) {
      return false;
    }
    const builderName = sanitizePlayerName(scout.name);
    scout.score -= lot.cost;
    this.inputs.ledger.capture(scout.id);
    this.inputs.furnaces.light(lot.id, builderName, scout.id);
    this.lastFurnaceBuildNotice = `${civicModuleName(builderName, lot.name)} is burning`;
    return true;
  }
}
