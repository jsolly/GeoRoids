import { advanceSettlement, emptySettlement } from '../../shared/economy';
import type { AsteroidMaterial, SettlementState } from '../../shared-types';

/** Owns shared settlement progress; each transition replaces its checkpoint identity. */
export class SettlementLedger {
  constructor(private state: SettlementState = emptySettlement()) {}

  current(): SettlementState {
    return this.state;
  }

  addPoints(points: number): void {
    this.state = advanceSettlement({ ...this.state, points: this.state.points + points });
  }

  addOre(resource: AsteroidMaterial | null, amount: number): void {
    const resources = { ...this.state.resources };
    if (resource) {
      resources[resource] += amount;
    }
    this.state = advanceSettlement({ ...this.state, resources });
  }

  reset(): void {
    this.state = emptySettlement();
  }
}
