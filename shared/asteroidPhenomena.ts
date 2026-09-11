import type { AsteroidData, Position } from '../shared-types';
import { previewAsteroidReflections, type ReflectionPreview } from './asteroidReflection';

export const ASTEROID_INTERACTIONS = {
  clusterCount: 2,
  rocksPerCluster: 3,
  reflectiveEnergy: 6,
  laserEnergyGain: 1.5,
  maxLaserEnergy: 8,
  maxBounces: 8,
  maxLaserFrames: 300,
  coreCharges: 6,
  coreLifetimeMs: 60_000,
  coreScore: 150,
} as const;

/** The runtime and aim preview share the exact charge/terminal decision. */
export function advanceReflectionEnergy(
  rockEnergy: number,
  maxRockEnergy: number,
  laserEnergy: number,
  bounces: number
) {
  const asteroidEnergy = Math.min(maxRockEnergy, rockEnergy + laserEnergy);
  const reflects =
    asteroidEnergy < maxRockEnergy &&
    laserEnergy < ASTEROID_INTERACTIONS.maxLaserEnergy &&
    bounces < ASTEROID_INTERACTIONS.maxBounces;
  return {
    asteroidEnergy,
    reflects,
    laserEnergy: Math.min(
      ASTEROID_INTERACTIONS.maxLaserEnergy,
      laserEnergy * ASTEROID_INTERACTIONS.laserEnergyGain
    ),
  };
}

export function previewChargedReflections(
  start: Position,
  direction: Position,
  rocks: readonly AsteroidData[],
  maxDistance: number,
  initialEnergy = 1
): ReflectionPreview {
  const energies = new Map<string, number>();
  let energy = initialEnergy;
  let bounces = 0;
  return previewAsteroidReflections(start, direction, rocks, {
    maxDistance,
    maxBounces: ASTEROID_INTERACTIONS.maxBounces,
    canReflect: (candidate) => {
      const rock = rocks.find((row) => row.id === candidate.id);
      if (rock?.phenomenon?.kind !== 'reflective') {
        return false;
      }
      const result = advanceReflectionEnergy(
        energies.get(rock.id) ?? rock.phenomenon.energy,
        rock.phenomenon.maxEnergy,
        energy,
        bounces
      );
      energies.set(rock.id, result.asteroidEnergy);
      if (result.reflects) {
        energy = result.laserEnergy;
        bounces++;
      }
      return result.reflects;
    },
  });
}

/** Decorate stable field slots once; never reseed a consumed cluster mid-belt. */
export function seedAsteroidPhenomena(rocks: AsteroidData[]): void {
  const candidates = rocks.filter((rock) => !rock.isCollabTarget && !rock.phenomenon);
  for (let cluster = 0; cluster < ASTEROID_INTERACTIONS.clusterCount; cluster++) {
    const group = candidates.slice(cluster * 3, cluster * 3 + 3);
    const first = group[0];
    if (group.length !== 3 || !first) {
      continue;
    }
    const center = { ...first.position };
    for (const [index, rock] of group.entries()) {
      const angle = (index * Math.PI * 2) / 3;
      rock.position = { x: center.x + Math.cos(angle) * 105, y: center.y + Math.sin(angle) * 105 };
      rock.velocity = { x: 0, y: 0 };
      rock.size = 32;
      rock.rotation = angle;
      rock.angularVelocity = 0;
      rock.vertices = 6;
      rock.offsets = [1, 0.8, 1, 1, 0.8, 1];
      rock.material = 'metal';
      rock.health = 75;
      rock.maxHealth = 75;
      rock.phenomenon = {
        kind: 'reflective',
        clusterId: first.id,
        energy: 0,
        maxEnergy: ASTEROID_INTERACTIONS.reflectiveEnergy,
      };
    }
  }
}

/** Fraction of a swept segment at first circle contact, including an inside origin. */
export function segmentCircleContact(
  start: Position,
  end: Position,
  center: Position,
  radius: number
): number | undefined {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const ox = start.x - center.x,
    oy = start.y - center.y;
  const c = ox * ox + oy * oy - radius * radius;
  if (c <= 0) {
    return 0;
  }
  const a = dx * dx + dy * dy;
  if (a <= 1e-12) {
    return undefined;
  }
  const b = 2 * (ox * dx + oy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return undefined;
  }
  const fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
  return fraction >= 0 && fraction <= 1 ? fraction : undefined;
}
