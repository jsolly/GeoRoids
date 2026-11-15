import { COOPERATIVE } from '../../shared/cooperativeRules';
import { SPIDER } from '../../shared/terrainSpider';
import type { SpiderPopulationInputs } from './types';

/** Allocate ordinary and reserved capacity over the current terrain and belt populations. */
export class SpiderPopulationBudget {
  constructor(private readonly inputs: SpiderPopulationInputs) {}

  public refresh(): void {
    if (!this.inputs.campaign.activated) {
      return;
    }
    const ordinary = SPIDER.MAX_ACTIVE - COOPERATIVE.swarmSlots;
    this.inputs.crawlers.setPopulationLimit(ordinary - this.inputs.spiders.ordinaryCount());
    this.inputs.spiders.setPopulationLimit(
      ordinary - this.inputs.crawlers.population,
      SPIDER.MAX_ACTIVE - this.inputs.crawlers.population
    );
  }
}
