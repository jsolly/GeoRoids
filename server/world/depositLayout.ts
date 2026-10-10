import { isInBeltFootprint } from '../../shared/asteroidBelt';
import { asteroidMaterialAt, MATERIAL_OUTLINES } from '../../shared/asteroidMaterials';
import {
  ASTEROID_INTERACTIONS,
  layoutReflectiveCluster,
  seedAsteroidPhenomena,
} from '../../shared/asteroidPhenomena';
import { applyColossalDeposit, sectorHostsColossal } from '../../shared/asteroidScale';
import { WORLD } from '../../shared/world';
import type { AsteroidData, AsteroidMaterial, Position } from '../../shared-types';
import { DAMAGE, DEPOSIT_FIELD, ROID } from '../../src/constants';
import { RNGService } from '../core/RNGService';

const SECTOR_EDGE_EPSILON = 1e-6;
/** Richness samples per sector axis; the mean sets the sector's slot count. */
const DENSITY_SAMPLES = 4;
const PLACEMENT_TRIES = 8;
function lattice(seed: number, x: number, y: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  hash = Math.imul(hash ^ (hash >>> 13), 1103515245);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function valueNoise(seed: number, x: number, y: number, scale: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, ix, iy);
  const b = lattice(seed, ix + 1, iy);
  const c = lattice(seed, ix, iy + 1);
  const d = lattice(seed, ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** 0 at launch, 1 once past the calm launch neighborhood. */
function launchCalm(position: Position): number {
  return smoothstep(
    DEPOSIT_FIELD.LAUNCH_CALM_INNER,
    DEPOSIT_FIELD.LAUNCH_CALM_OUTER,
    Math.hypot(position.x, position.y)
  );
}

/**
 * 0 in a void, 1 in the core of a rich field. Continuous across sector edges.
 * New pilots launch into a busy but survivable neighborhood.
 */
export function fieldRichness(seed: number, position: Position): number {
  const field = valueNoise(seed ^ 0x5bd1e995, position.x, position.y, DEPOSIT_FIELD.FIELD_SCALE);
  const clump = valueNoise(seed ^ 0x27d4eb2d, position.x, position.y, DEPOSIT_FIELD.CLUMP_SCALE);
  const richness =
    smoothstep(DEPOSIT_FIELD.FIELD_EDGE_LOW, DEPOSIT_FIELD.FIELD_EDGE_HIGH, field) *
    lerp(DEPOSIT_FIELD.CLUMP_FLOOR, 1, clump);
  return Math.min(richness, lerp(DEPOSIT_FIELD.LAUNCH_RICHNESS, 1, launchCalm(position)));
}

function depositsPerSectorAt(richness: number): number {
  return lerp(DEPOSIT_FIELD.VOID_DEPOSITS, DEPOSIT_FIELD.PEAK_DEPOSITS, richness);
}

function outline(material: AsteroidMaterial, random: RNGService): number[] {
  const base = MATERIAL_OUTLINES[material];
  const count = base.length + Math.floor(random.random() * (ROID.EXTRA_VERTICES[material] + 1));
  const jitter = ROID.OUTLINE_JITTER[material];
  return Array.from(
    { length: count },
    // Two decimals keep keyframes compact; the silhouette difference is invisible.
    (_, index) =>
      Math.round(
        (base[index % base.length] ?? 1) * (1 + (random.random() - 0.5) * 2 * jitter) * 100
      ) / 100
  );
}

/** Keep intact pinball pockets off sector edges. */
function placeReflectiveClusters(rocks: AsteroidData[], x: number, y: number): void {
  const groups = new Map<string, AsteroidData[]>();
  for (const rock of rocks) {
    if (rock.phenomenon?.kind === 'reflective') {
      const group = groups.get(rock.phenomenon.clusterId) ?? [];
      group.push(rock);
      groups.set(rock.phenomenon.clusterId, group);
    }
  }
  const extent = ASTEROID_INTERACTIONS.clusterRadius + ASTEROID_INTERACTIONS.reflectiveSize + 1;
  for (const group of groups.values()) {
    if (group.length !== ASTEROID_INTERACTIONS.rocksPerCluster) {
      continue;
    }
    const center = {
      x: Math.min(
        (x + 1) * WORLD.sectorSize - extent,
        Math.max(
          x * WORLD.sectorSize + extent,
          group.reduce((sum, rock) => sum + rock.position.x, 0) / group.length
        )
      ),
      y: Math.min(
        (y + 1) * WORLD.sectorSize - extent,
        Math.max(
          y * WORLD.sectorSize + extent,
          group.reduce((sum, rock) => sum + rock.position.y, 0) / group.length
        )
      ),
    };
    // At the circular rim, keep the original group rather than placing a
    // pocket partly outside the playable world.
    if (Math.hypot(center.x, center.y) + extent > WORLD.radius) {
      continue;
    }
    for (const [index, placement] of layoutReflectiveCluster(center).entries()) {
      const rock = group[index];
      if (rock) {
        rock.position = { ...placement.position };
        rock.rotation = placement.rotation;
      }
    }
  }
}

/** Resize one ordinary slot; keep pinball clusters intact. */
function placeColossalDeposit(rocks: AsteroidData[], x: number, y: number, seed: number): void {
  if (!sectorHostsColossal(x, y, seed)) {
    return;
  }
  const slot =
    rocks.find((rock) => !rock.phenomenon && rock.velocity.x === 0 && rock.velocity.y === 0) ??
    rocks.find((rock) => !rock.phenomenon);
  if (slot) {
    applyColossalDeposit(slot);
  }
}

/**
 * The deterministic deposits a sector owns. Slot IDs and every property are a
 * pure function of seed and sector, so a missing slot regrows identically.
 */
export function sectorDeposits(seed: number, x: number, y: number): AsteroidData[] {
  const random = new RNGService(seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663));
  const minX = x * WORLD.sectorSize;
  const minY = y * WORLD.sectorSize;
  const samples: number[] = [];
  for (let sy = 0; sy < DENSITY_SAMPLES; sy++) {
    for (let sx = 0; sx < DENSITY_SAMPLES; sx++) {
      samples.push(
        fieldRichness(seed, {
          x: minX + ((sx + 0.5) / DENSITY_SAMPLES) * WORLD.sectorSize,
          y: minY + ((sy + 0.5) / DENSITY_SAMPLES) * WORLD.sectorSize,
        })
      );
    }
  }
  const meanRichness = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const peakDensity = depositsPerSectorAt(Math.max(...samples));
  const slots = Math.round(depositsPerSectorAt(meanRichness));
  const rocks: AsteroidData[] = [];
  for (let index = 0; index < slots; index++) {
    // Rejection sampling follows the continuous field, so clumps cross
    // sector edges instead of piling up against them.
    let position = { x: 0, y: 0 };
    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      position = {
        x: minX + random.random() * WORLD.sectorSize,
        y: minY + random.random() * WORLD.sectorSize,
      };
      if (random.random() * peakDensity <= depositsPerSectorAt(fieldRichness(seed, position))) {
        break;
      }
    }
    // Draw every value for every slot so later slot properties stay seed-stable.
    const richness = fieldRichness(seed, position);
    const material = asteroidMaterialAt(index);
    const offsets = outline(material, random);
    const health = DAMAGE.LASER_HIT * (material === 'metal' ? ROID.METAL_HITS : 1);
    const size =
      ROID.DEPOSIT_SIZE_MIN +
      (ROID.DEPOSIT_SIZE_MAX - ROID.DEPOSIT_SIZE_MIN) * random.random() ** ROID.DEPOSIT_SIZE_SKEW;
    const smallness =
      1 - (size - ROID.DEPOSIT_SIZE_MIN) / (ROID.DEPOSIT_SIZE_MAX - ROID.DEPOSIT_SIZE_MIN);
    const stationary =
      random.random() <
      lerp(
        DEPOSIT_FIELD.STATIONARY_FRACTION_VOID,
        DEPOSIT_FIELD.STATIONARY_FRACTION_PEAK,
        richness
      );
    const fast = random.random() < ROID.FAST_DRIFT_CHANCE * launchCalm(position);
    const pace = random.random();
    const speed = Math.min(
      ROID.SERVER_VELOCITY_MAX,
      fast
        ? lerp(ROID.FAST_DRIFT_SPEED_MIN, ROID.SERVER_VELOCITY_MAX, pace)
        : lerp(ROID.DRIFT_SPEED_MIN, ROID.DRIFT_SPEED_MAX, pace ** 2) *
            lerp(ROID.LARGE_ROCK_PACE, ROID.SMALL_ROCK_PACE, smallness)
    );
    const direction = random.random() * Math.PI * 2;
    const spin =
      lerp(ROID.SPIN_MIN, ROID.SPIN_MAX, random.random() ** 3) *
      lerp(ROID.LARGE_ROCK_SPIN, ROID.SMALL_ROCK_SPIN, smallness) *
      (random.random() < 0.5 ? -1 : 1);
    const rotation = random.random() * Math.PI * 2;
    const jaggedness =
      ROID.DEPOSIT_JAGGEDNESS[material === 'rubble' ? 'rubble' : 'solid'] +
      random.random() * ROID.DEPOSIT_JAGGEDNESS_SPREAD;
    // The belt keeps its clear lanes; the rim keeps a margin. Skipped slot
    // indices stay unused, so later slots keep their identity.
    if (
      Math.hypot(position.x, position.y) > WORLD.radius - DEPOSIT_FIELD.RIM_MARGIN ||
      isInBeltFootprint(position)
    ) {
      continue;
    }
    // Keep the launch area navigable; nearby deposits still fit inside the first
    // scan. Sectors meet at the origin, so a radial push never changes sector.
    const fromLaunch = Math.hypot(position.x, position.y);
    if (fromLaunch < DEPOSIT_FIELD.LAUNCH_CLEARANCE) {
      const scale = DEPOSIT_FIELD.LAUNCH_CLEARANCE / Math.max(fromLaunch, 1e-6);
      position = { x: position.x * scale, y: position.y * scale };
    }
    rocks.push({
      id: `deposit-${seed}-${x}-${y}-${index}`,
      position,
      velocity: stationary
        ? { x: 0, y: 0 }
        : { x: Math.cos(direction) * speed, y: Math.sin(direction) * speed },
      size,
      material,
      health,
      maxHealth: health,
      rotation,
      angularVelocity: spin,
      jaggedness,
      vertices: offsets.length,
      offsets,
    });
  }
  seedAsteroidPhenomena(rocks);
  placeReflectiveClusters(rocks, x, y);
  placeColossalDeposit(rocks, x, y, seed);
  // Phenomenon clusters may move a generated slot across an edge. Keep the slot owned by its deterministic sector;
  // later simulation drift is what transfers ownership during checkpointing.
  const maxX = (x + 1) * WORLD.sectorSize - SECTOR_EDGE_EPSILON;
  const maxY = (y + 1) * WORLD.sectorSize - SECTOR_EDGE_EPSILON;
  for (const rock of rocks) {
    rock.position = {
      x: Math.min(maxX, Math.max(minX, rock.position.x)),
      y: Math.min(maxY, Math.max(minY, rock.position.y)),
    };
  }
  // Clusters can extend beyond the circular world even when their anchor is inside.
  return rocks.filter((rock) => Math.hypot(rock.position.x, rock.position.y) <= WORLD.radius);
}
