import type { AsteroidData } from '../shared-types';
import { DAMAGE, ROID } from '../src/constants';

/** Crew-scale rocks sit well above the ordinary large/collab class. */
export function isColossalAsteroid(size: number): boolean {
  return size >= ROID.COLOSSAL_MIN_SIZE;
}

/** Ordinary rocks need one Hauler; a colossal deposit needs a crew. */
export function asteroidCrewNeeded(size: number): 1 | typeof ROID.COLOSSAL_CREW {
  return isColossalAsteroid(size) ? ROID.COLOSSAL_CREW : 1;
}

export function colossalMiningHealth(): number {
  return DAMAGE.LASER_HIT * ROID.COLOSSAL_LASER_HITS;
}

/** Keep the launch neighborhood free of immovable landmarks. */
export function sectorHostsColossal(x: number, y: number, seed: number): boolean {
  if (Math.max(Math.abs(x), Math.abs(y)) < ROID.COLOSSAL_CORE_EXCLUSION) {
    return false;
  }
  return (
    ((Math.imul(x, 747796405) ^ Math.imul(y, 1597334677) ^ seed) >>> 0) %
      ROID.COLOSSAL_SECTOR_PERIOD ===
    0
  );
}

/** Resize an existing generated slot; do not add a new deposit ID. */
export function applyColossalDeposit(rock: AsteroidData): void {
  rock.size = ROID.COLOSSAL_SIZE;
  rock.health = colossalMiningHealth();
  rock.maxHealth = rock.health;
  rock.velocity = { x: 0, y: 0 };
  rock.jaggedness = Math.max(rock.jaggedness, 0.45);
}
