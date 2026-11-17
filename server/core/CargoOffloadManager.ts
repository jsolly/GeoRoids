import { ECONOMY } from '../../shared/economy';
import type { FurnaceField } from '../../shared/furnaceField';
import { hullRadiusForKit } from '../../shared/shipKits';
import type { EntityManager, GameEntity } from './EntityManager';

interface CargoOffloadInputs {
  readonly actors: Pick<EntityManager, 'getAllEntities'>;
  readonly furnaces: Pick<FurnaceField, 'intakeAt'>;
  readonly awardPilotPoints: (id: string, points: number) => void;
}

/** Owns continuous intake cadence; actor replacement naturally retires old WeakMap keys. */
export class CargoOffloadManager {
  private readonly ticks = new WeakMap<GameEntity, { furnaceId: string; frames: number }>();

  constructor(private readonly inputs: CargoOffloadInputs) {}

  advance(): void {
    for (const pilot of this.inputs.actors.getAllEntities()) {
      if (
        pilot.health <= 0 ||
        pilot.exploding ||
        pilot.respawnTimer !== undefined ||
        pilot.cargo <= 0 ||
        pilot.furnaceTransit
      ) {
        this.ticks.delete(pilot);
        continue;
      }
      const furnace = this.inputs.furnaces.intakeAt(pilot.position, hullRadiusForKit(pilot.kitId));
      if (!furnace) {
        this.ticks.delete(pilot);
        continue;
      }
      const previous = this.ticks.get(pilot);
      const frames = previous?.furnaceId === furnace.id ? previous.frames + 1 : 1;
      if (frames < ECONOMY.offloadIntervalFrames) {
        this.ticks.set(pilot, { furnaceId: furnace.id, frames });
        continue;
      }
      this.ticks.delete(pilot);
      const points = Math.min(pilot.cargo, ECONOMY.offloadPoints);
      pilot.cargo -= points;
      pilot.bankedCargo = (pilot.bankedCargo ?? 0) + points;
      this.inputs.awardPilotPoints(pilot.id, points);
    }
  }
}
