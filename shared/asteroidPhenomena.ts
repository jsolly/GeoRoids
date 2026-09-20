import type { AsteroidData, Position } from '../shared-types';
import { GAME } from '../src/constants';
import { previewAsteroidReflections, type ReflectionPreview } from './asteroidReflection';

export const ASTEROID_INTERACTIONS = {
  clusterCount: 2,
  rocksPerCluster: 3,
  clusterRadius: 44,
  reflectiveSize: 32,
  reflectiveEnergy: 6,
  laserEnergyGain: 1.5,
  maxLaserEnergy: 8,
  maxBounces: 8,
  /** Inverse-scaled age guard keeps reflection travel distance unchanged. */
  maxLaserFrames: Math.ceil(300 / GAME.MOTION_SCALE),
  coreCharges: 6,
  coreLifetimeMs: 60_000,
  coreScore: 150,
} as const;

/**
 * Place the three reflective rocks as a compact, stationary pinball pocket.
 *
 * The ring leaves a small central lane between the rocks while keeping an
 * external shot within reach of multiple inward-facing hexagon facets. The
 * returned poses deliberately contain no mutable asteroid state so callers
 * can preserve each rock's identity, contour, charge, and health.
 */
export function layoutReflectiveCluster(center: Position): Array<{
  position: Position;
  rotation: number;
}> {
  const placements: Array<{ position: Position; rotation: number }> = [];
  for (let index = 0; index < ASTEROID_INTERACTIONS.rocksPerCluster; index += 1) {
    const radialAngle = (index * Math.PI * 2) / ASTEROID_INTERACTIONS.rocksPerCluster;
    placements.push({
      position: {
        x: center.x + Math.cos(radialAngle) * ASTEROID_INTERACTIONS.clusterRadius,
        y: center.y + Math.sin(radialAngle) * ASTEROID_INTERACTIONS.clusterRadius,
      },
      // Polygon edge 0→1 has an outward normal at rotation + π/6. Aim it at
      // the centroid (radialAngle + π) to make that face point inward.
      rotation: radialAngle + (5 * Math.PI) / 6,
    });
  }
  return placements;
}

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
    const group = candidates.slice(
      cluster * ASTEROID_INTERACTIONS.rocksPerCluster,
      cluster * ASTEROID_INTERACTIONS.rocksPerCluster + ASTEROID_INTERACTIONS.rocksPerCluster
    );
    const first = group[0];
    if (group.length !== ASTEROID_INTERACTIONS.rocksPerCluster || !first) {
      continue;
    }
    const center = { ...first.position };
    const placements = layoutReflectiveCluster(center);
    for (const [index, rock] of group.entries()) {
      const placement = placements[index];
      if (!placement) {
        continue;
      }
      rock.position = { ...placement.position };
      rock.velocity = { x: 0, y: 0 };
      rock.size = ASTEROID_INTERACTIONS.reflectiveSize;
      rock.rotation = placement.rotation;
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
