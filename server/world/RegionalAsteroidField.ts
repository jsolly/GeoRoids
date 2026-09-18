import { asteroidMaterialAt, MATERIAL_OUTLINES } from '../../shared/asteroidMaterials';
import { seedAsteroidPhenomena } from '../../shared/asteroidPhenomena';
import { parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type { AsteroidData, Position } from '../../shared-types';
import { ROID } from '../../src/constants';
import type { AsteroidManager } from '../core/AsteroidManager';
import { RNGService } from '../core/RNGService';

const SECTOR_EDGE_EPSILON = 1e-6;

/**
 * Distant sectors sleep; visited empty sectors never regenerate harvested deposits.
 *
 * Every saved sector stays in memory as a dormant sector, so activating,
 * sleeping and counting sectors never reads the database while the game runs.
 * At the world's full 60,000-unit radius that is at most a few thousand
 * sectors of deposit rows, well within a game server's memory.
 */
export class RegionalAsteroidField {
  private active = new Set<string>();
  private readonly dormant: Map<string, AsteroidData[]>;
  private changed = new Map<string, AsteroidData[]>();
  private visited = new Set<string>();

  constructor(
    private readonly seed: number,
    saved: ReadonlyMap<string, AsteroidData[]> = new Map()
  ) {
    this.dormant = new Map(saved);
  }

  private generate(x: number, y: number): AsteroidData[] {
    const random = new RNGService(this.seed ^ Math.imul(x, 73856093) ^ Math.imul(y, 19349663));
    const rocks: AsteroidData[] = [];
    for (let index = 0; index < WORLD.depositsPerSector; index++) {
      const position = {
        x: (x + random.random()) * WORLD.sectorSize,
        y: (y + random.random()) * WORLD.sectorSize,
      };
      if (Math.hypot(position.x, position.y) > WORLD.radius - 100) {
        continue;
      }
      // Keep the launch area navigable; nearby deposits still fit inside the first scan.
      if (Math.hypot(position.x, position.y) < 160) {
        position.x += 240;
      }
      const material = asteroidMaterialAt(index);
      const offsets = [...MATERIAL_OUTLINES[material]];
      const health = material === 'metal' ? 75 : 25;
      rocks.push({
        id: `deposit-${this.seed}-${x}-${y}-${index}`,
        position,
        velocity: random.randomVelocity(ROID.SERVER_VELOCITY_MAX),
        size: 18 + random.random() * 30,
        material,
        health,
        maxHealth: health,
        rotation: random.random() * Math.PI * 2,
        angularVelocity: (random.random() - 0.5) * 0.005,
        jaggedness: material === 'rubble' ? 0.7 : 0.25,
        vertices: offsets.length,
        offsets,
      });
    }
    const collab = rocks[0];
    if (collab) {
      collab.size = Math.max(collab.size, ROID.COLLAB_SPLIT_MIN_SIZE);
      collab.isCollabTarget = true;
      collab.health = 100;
      collab.maxHealth = 100;
    }
    seedAsteroidPhenomena(rocks);
    // Phenomenon clusters and the launch-area offset may move a generated
    // slot across an edge. Keep the slot owned by its deterministic sector;
    // later simulation drift is what transfers ownership during checkpointing.
    const minX = x * WORLD.sectorSize;
    const minY = y * WORLD.sectorSize;
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

  private load(id: string): AsteroidData[] {
    this.visited.add(id);
    const cached = this.dormant.get(id);
    if (cached) {
      return cached;
    }
    const parsed = parseSectorId(id);
    if (!parsed) {
      throw new Error('Invalid sector identity');
    }
    return this.generate(parsed.x, parsed.y);
  }

  update(
    manager: AsteroidManager,
    observers: readonly Position[],
    completed: ReadonlySet<string>
  ): AsteroidData[] {
    const wanted = new Map<string, { x: number; y: number }>();
    for (const observer of observers) {
      const start = sectorAt({
        x: observer.x - WORLD.interestRadius,
        y: observer.y - WORLD.interestRadius,
      });
      const end = sectorAt({
        x: observer.x + WORLD.interestRadius,
        y: observer.y + WORLD.interestRadius,
      });
      for (let y = start.y; y <= end.y; y++) {
        for (let x = start.x; x <= end.x; x++) {
          const id = `${x},${y}`;
          if (
            completed.has(id) ||
            Math.hypot((x + 0.5) * WORLD.sectorSize, (y + 0.5) * WORLD.sectorSize) >
              WORLD.radius + WORLD.sectorSize
          ) {
            continue;
          }
          wanted.set(id, { x, y });
        }
      }
    }
    this.sleepDistantSectors(manager, new Set(wanted.keys()));
    const created: AsteroidData[] = [];
    for (const id of wanted.keys()) {
      if (this.active.has(id)) {
        continue;
      }
      const rows = this.load(id);
      this.dormant.delete(id);
      for (const rock of rows) {
        if (manager.getAsteroid(rock.id)) {
          continue;
        }
        manager.addAsteroid(rock);
        created.push(rock);
      }
    }
    this.active = new Set(wanted.keys());
    return created;
  }

  private sleepDistantSectors(manager: AsteroidManager, wanted: ReadonlySet<string>): void {
    // Partition current positions, including rocks carried across sector boundaries.
    const bySector = new Map<string, AsteroidData[]>([...this.active].map((id) => [id, []]));
    for (const rock of manager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      let rows = bySector.get(id);
      if (!rows) {
        rows = [];
        bySector.set(id, rows);
      }
      rows.push(rock);
    }
    for (const [id, rows] of bySector) {
      if (wanted.has(id)) {
        continue;
      }
      const prior = this.active.has(id) ? [] : this.load(id);
      const saved = [...new Map([...prior, ...rows].map((rock) => [rock.id, rock])).values()];
      this.dormant.set(id, saved);
      this.changed.set(id, saved);
      for (const rock of rows) {
        manager.removeAsteroid(rock.id);
      }
    }
  }

  checkpoint(manager: AsteroidManager): ReadonlyMap<string, AsteroidData[]> {
    this.sleepDistantSectors(manager, this.active);
    const rows = new Map(this.changed);
    for (const id of this.active) {
      rows.set(id, []);
    }
    for (const rock of manager.getAllAsteroids()) {
      const id = sectorAt(rock.position).id;
      const sector = rows.get(id);
      if (!sector) {
        throw new Error(`Active asteroid ${rock.id} has no sector ${id}`);
      }
      sector.push(rock);
    }
    return rows;
  }

  /** The pending changes were handed to persistence; dormant rows stay as the in-memory world. */
  saved(): void {
    this.changed.clear();
  }

  reset(): void {
    this.active.clear();
    this.dormant.clear();
    this.changed.clear();
    this.visited.clear();
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  hasVisited(id: string): boolean {
    return this.visited.has(id) || this.active.has(id) || this.dormant.has(id);
  }

  visitedSectorIds(): string[] {
    const ids = new Set(this.visited);
    for (const id of this.active) {
      ids.add(id);
    }
    for (const id of this.dormant.keys()) {
      ids.add(id);
    }
    return [...ids];
  }

  dormantSectors(): ReadonlyMap<string, AsteroidData[]> {
    return this.dormant;
  }
}
