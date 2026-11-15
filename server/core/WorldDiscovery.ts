import type { Position } from '../../shared-types';
import type { WorldDiscoveryInputs } from './types';

/** Reveals shared ground and records the valuable loot discovered within it. */
export class WorldDiscovery {
  constructor(private readonly inputs: WorldDiscoveryInputs) {}

  revealArea(position: Position, range: number): void {
    for (const cell of this.inputs.exploration.reveal(position, range)) {
      for (const drop of this.inputs.loot.queryExplorationCell(cell)) {
        this.inputs.assets.discovered(drop.id);
      }
    }
  }
}
