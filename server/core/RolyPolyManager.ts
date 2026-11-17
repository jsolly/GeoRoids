import { containAsteroidPositionInto } from '../../shared/asteroidMotion';
import { sampleGradient } from '../../shared/heightfield';
import { ROLY_POLY } from '../../shared/rolyPoly';
import { hullRadiusForKit } from '../../shared/shipKits';
import { getTerrainField } from '../../shared/terrainField';
import { isWithinWorldInterest, WORLD } from '../../shared/world';
import type { Position, RolyPolyState } from '../../shared-types';
import type { EntityManager } from './EntityManager';

type Animal = { state: RolyPolyState; rollsUntil: number; direction: number };

/** Only currently visited habitats exist in memory; no saved-world scans or persistence. */
export class RolyPolyManager {
  private readonly animals = new Map<string, Animal>();

  constructor(private readonly actors: Pick<EntityManager, 'getAllEntities'>) {}

  advance(frame: number): void {
    const pilots = this.actors.getAllEntities().map((pilot) => ({
      position: pilot.position,
      velocity: pilot.velocity,
      health: pilot.health,
      exploding: pilot.exploding,
      radius: hullRadiusForKit(pilot.kitId),
    }));
    const living = pilots.filter((pilot) => pilot.health > 0 && !pilot.exploding);
    if (frame % 60 === 0 || this.animals.size === 0) {
      this.populate(living);
    }
    const terrain = getTerrainField();
    for (const animal of this.animals.values()) {
      const state = animal.state;
      const close = living.find(
        (pilot) =>
          Math.hypot(pilot.position.x - state.position.x, pilot.position.y - state.position.y) <
          ROLY_POLY.curlDistance
      );
      const touching = living.find(
        (pilot) =>
          Math.hypot(pilot.position.x - state.position.x, pilot.position.y - state.position.y) <=
          ROLY_POLY.radius + pilot.radius
      );
      const gradient = sampleGradient(terrain, state.position.x, state.position.y);
      const length = Math.hypot(gradient.x, gradient.y);
      const tx = length > 1e-8 ? -gradient.y / length : 1;
      const ty = length > 1e-8 ? gradient.x / length : 0;
      if (touching && frame >= animal.rollsUntil) {
        const projection = touching.velocity.x * tx + touching.velocity.y * ty;
        animal.direction = projection === 0 ? animal.direction : Math.sign(projection);
        animal.rollsUntil = frame + ROLY_POLY.rollFrames;
      }
      state.phase = frame < animal.rollsUntil ? 'rolling' : close ? 'curled' : 'walking';
      const speed =
        state.phase === 'rolling'
          ? ROLY_POLY.rollSpeed
          : state.phase === 'walking'
            ? ROLY_POLY.crawlSpeed
            : 0;
      state.velocity =
        speed === 0
          ? { x: 0, y: 0 }
          : { x: tx * speed * animal.direction, y: ty * speed * animal.direction };
      containAsteroidPositionInto(
        state.position,
        state.position.x + state.velocity.x,
        state.position.y + state.velocity.y
      );
    }
  }

  private populate(pilots: readonly { position: Position }[]): void {
    for (const [id, animal] of this.animals) {
      if (!pilots.some((pilot) => isWithinWorldInterest(animal.state.position, pilot.position))) {
        this.animals.delete(id);
      }
    }
    for (const pilot of pilots) {
      const cx = Math.floor(pilot.position.x / ROLY_POLY.habitatSize);
      const cy = Math.floor(pilot.position.y / ROLY_POLY.habitatSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (this.animals.size >= ROLY_POLY.maximumActive) {
            return;
          }
          const x = cx + dx;
          const y = cy + dy;
          if ((x + y) % 2 !== 0) {
            continue;
          }
          const id = `roly-poly:${x},${y}`;
          const position = {
            x: (x + 0.65) * ROLY_POLY.habitatSize,
            y: (y + 0.35) * ROLY_POLY.habitatSize,
          };
          if (Math.hypot(position.x, position.y) > WORLD.radius - 100 || this.animals.has(id)) {
            continue;
          }
          this.animals.set(id, {
            state: { id, position, velocity: { x: 0, y: 0 }, phase: 'walking' },
            rollsUntil: 0,
            direction: x % 2 === 0 ? 1 : -1,
          });
        }
      }
    }
  }

  snapshot(): RolyPolyState[] {
    return [...this.animals.values()].map(({ state }) => ({
      ...state,
      position: { ...state.position },
      velocity: { ...state.velocity },
    }));
  }

  clear(): void {
    this.animals.clear();
  }
}
