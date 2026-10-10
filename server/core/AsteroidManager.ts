import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import { tickAsteroidBoost } from '../../shared/asteroidBoost';
import { asteroidMaterialAt, MATERIAL_OUTLINES } from '../../shared/asteroidMaterials';
import { isColossalAsteroid } from '../../shared/asteroidScale';
import { oreResource } from '../../shared/economy';
import { FurnaceField } from '../../shared/furnaceField';
import { WORLD } from '../../shared/world';
import type { AsteroidData, Position } from '../../shared-types';
import { DAMAGE, DEBUG, GAME, ROID } from '../../src/constants';
import {
  containAsteroidPosition,
  getAsteroidFieldRadius,
  stepAsteroidMotionInto,
} from '../../src/physics/asteroidMotion';
import { isDebugMode } from '../../src/utils/debugUtils';
import { AsteroidSpatialIndex } from '../world/AsteroidSpatialIndex';
import type { RNGService } from './RNGService';

export type AsteroidHitCause = 'laser' | 'collision';

export type AsteroidHitOutcome = {
  outcome: 'missing' | 'damaged' | 'ignored' | 'destroyed';
  destroyed?: AsteroidData;
  newAsteroids: AsteroidData[];
};

export class AsteroidManager {
  private asteroids = new Map<string, AsteroidData>();
  private readonly index = new AsteroidSpatialIndex([]);
  private rng: RNGService;
  /** Per-manager identity prevents delayed reports surviving a server restart. */
  private readonly managerNonce = randomUUID();
  /** Monotonic field generation; never reused after a clear in this manager. */
  private fieldGeneration = 0;

  // Asteroid splitting constants - can be overridden by DEBUG settings
  private readonly MIN_ASTEROID_SIZE = 10;
  private readonly COLOSSAL_SPLIT_SIZE_RATIO = 0.5;

  constructor(
    rngService: RNGService,
    private readonly furnaces = new FurnaceField(),
    private readonly onDestroyed?: (rock: AsteroidData) => void
  ) {
    this.rng = rngService;
  }

  // Getter methods for asteroid configuration
  private get minAsteroidSize(): number {
    return this.MIN_ASTEROID_SIZE;
  }

  public addAsteroid(asteroid: AsteroidData): void {
    this.asteroids.set(asteroid.id, asteroid);
    this.index.add(asteroid);
  }

  public removeAsteroid(asteroidId: string): AsteroidData | undefined {
    const asteroid = this.asteroids.get(asteroidId);
    if (asteroid) {
      this.asteroids.delete(asteroidId);
      this.index.remove(asteroidId);
    }
    return asteroid;
  }

  /**
   * The one broad phase shared by lasers, collisions, crawlers, scans and
   * snapshots. It lives as long as the manager and stays exact: additions,
   * removals, edits and each motion step update it in place, preserving row
   * order. Rows are live objects, so direct geometry edits must `refile`.
   */
  public spatialIndex(): AsteroidSpatialIndex {
    return this.index;
  }

  /**
   * Re-file rows whose geometry was rewritten in place. Rows are live objects;
   * code that edits position, size or outline directly must call this.
   */
  public refile(rocks: Iterable<AsteroidData>): void {
    for (const rock of rocks) {
      this.index.move(rock);
    }
  }

  public updateAsteroid(
    asteroidId: string,
    updates: Partial<AsteroidData>
  ): AsteroidData | undefined {
    const asteroid = this.asteroids.get(asteroidId);
    if (asteroid) {
      Object.assign(asteroid, updates);
      // Position, size or outline may have changed the rock's cells.
      this.index.move(asteroid);
    }
    return asteroid;
  }

  public getAsteroid(asteroidId: string): AsteroidData | undefined {
    return this.asteroids.get(asteroidId);
  }

  public getAllAsteroids(): AsteroidData[] {
    return Array.from(this.asteroids.values());
  }

  public getAsteroidCount(): number {
    return this.asteroids.size;
  }

  public clearAsteroids(): void {
    for (const id of [...this.asteroids.keys()]) {
      this.removeAsteroid(id);
    }
    this.index.clear();
  }

  /**
   * Advance every asteroid one simulation frame (same units as client `moveRoids`:
   * velocity is pixels per 60 FPS tick). Debug placement modes stay frozen so
   * collision tests that pin roids on ships do not drift.
   */
  public updateMotion(captureMotion = false): void {
    this.index.beginMotion(captureMotion);
    if (DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER) {
      return;
    }

    for (const asteroid of this.asteroids.values()) {
      const previous = captureMotion
        ? { ...asteroid.position, rotation: asteroid.rotation }
        : undefined;
      tickAsteroidBoost(asteroid, asteroid.size, this.furnaces);
      stepAsteroidMotionInto(
        asteroid.position,
        asteroid.velocity,
        1,
        asteroid.position,
        asteroid.velocity
      );
      asteroid.rotation += asteroid.angularVelocity;
      this.index.move(asteroid, previous);
    }
  }

  public createAsteroids(
    count: number,
    bounds = { radius: getAsteroidFieldRadius() },
    playerPositions: Position[] = []
  ): AsteroidData[] {
    // If we already have asteroids and no player positions are provided, return them instead of recreating
    // But if player positions are provided, we should recreate to place roids on players
    // Also recreate if we're in test mode (PLACE_ON_LOCAL_PLAYER is true)
    const isTestMode = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
    logger.debug(
      'AsteroidManager: isTestMode =',
      isTestMode,
      'playerPositions.length =',
      playerPositions.length,
      'existing asteroids =',
      this.asteroids.size
    );
    if (this.asteroids.size > 0 && playerPositions.length === 0 && !isTestMode) {
      logger.debug('AsteroidManager: Returning existing asteroids instead of recreating');
      return Array.from(this.asteroids.values());
    }

    // Clear existing asteroids only if we're creating new ones
    this.clearAsteroids();

    // Reset RNG for deterministic asteroid generation
    this.rng.reset();
    this.fieldGeneration += 1;
    const generation = this.fieldGeneration;

    // The requested count remains useful to deterministic tests and explicit
    // tools. Only the opt-in debug mode overrides it; production callers pass
    // the canonical ROID.INITIAL_ROID_COUNT from GameEngine.
    const asteroidCount = isDebugMode() ? DEBUG.ROIDS.INITIAL_COUNT : count;
    const newAsteroids: AsteroidData[] = [];

    // Scope deterministic slot IDs to this field generation. A delayed
    // destroy/hit from a prior depleted field must never address a new rock.
    for (let i = 0; i < asteroidCount; i++) {
      const asteroidId = `server-asteroid-${this.managerNonce}-${generation}-${i}`;

      // Determine position based on DEBUG settings
      let position: Position;
      if (DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER && playerPositions.length > 0) {
        // Place asteroids exactly on players when PLACE_ON_LOCAL_PLAYER is true (for testing)
        const playerPos = playerPositions[i % playerPositions.length];
        if (playerPos === undefined) {
          position = this.rng.randomPosition(bounds);
        } else {
          // Place asteroids exactly on the player for collision testing
          position = {
            x: playerPos.x,
            y: playerPos.y,
          };
        }
      } else {
        position = this.rng.randomPosition(bounds);
      }

      const velocity = this.rng.randomVelocity(ROID.SERVER_VELOCITY_MAX);

      const material = asteroidMaterialAt(i);
      const healthValue = DAMAGE.LASER_HIT * (material === 'metal' ? 3 : 1);
      const jaggedness = material === 'rubble' ? 0.7 : 0.25;
      const offsets = MATERIAL_OUTLINES[material].map(
        (offset) => offset * (0.96 + this.rng.random() * 0.08)
      );
      const vertices = offsets.length;

      // Determine size based on DEBUG settings
      let size: number;
      // Check if we're in test mode (when PLACE_ON_LOCAL_PLAYER is true, assume test mode)
      const localTestMode = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;

      if (DEBUG.ENABLED && DEBUG.ROIDS.ALL_LARGE && !localTestMode) {
        size = 50; // Large size
      } else if (localTestMode) {
        // In test mode, create medium asteroids (size 20-30).
        size = this.rng.random() * 10 + 20;
      } else {
        // Mixed sizes make mineral silhouettes and rubble fragments readable.
        size = this.rng.random() * 30 + 18;
      }

      const asteroid: AsteroidData = {
        id: asteroidId,
        position,
        velocity,
        size,
        jaggedness,
        rotation: this.rng.random() * Math.PI * 2,
        // Keep the server-owned spin in step with the client fallback.
        angularVelocity: (this.rng.random() - 0.5) * 0.01 * GAME.MOTION_SCALE,
        health: healthValue,
        maxHealth: healthValue,
        vertices,
        offsets,
        material,
      };

      this.addAsteroid(asteroid);
      newAsteroids.push(asteroid);
    }

    return newAsteroids;
  }

  /** Apply one accepted mining shot; only durable deposits require more hits. */
  public registerLaserHit(
    asteroidId: string,
    shooterId: string,
    miningDamage: number = DAMAGE.LASER_HIT
  ): AsteroidHitOutcome {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) {
      return { outcome: 'missing', newAsteroids: [] };
    }
    if (asteroid.boost?.phase === 'burning') {
      return { outcome: 'ignored', newAsteroids: [] };
    }
    this.recordMiningHit(asteroidId, shooterId);
    if (isColossalAsteroid(asteroid.size) || asteroid.material === 'metal') {
      asteroid.health = Math.max(0, asteroid.health - miningDamage);
      if (asteroid.health > 0) {
        return { outcome: 'damaged', newAsteroids: [] };
      }
      return this.finishDestroy(asteroidId, isColossalAsteroid(asteroid.size));
    }
    return this.finishDestroy(
      asteroidId,
      asteroid.material === 'rubble' && asteroid.size > this.minAsteroidSize * 2
    );
  }

  /** Ship-ram / non-laser destroy: never splits. Colossal rocks survive the bump. */
  public destroyFromCollision(asteroidId: string): AsteroidHitOutcome {
    const asteroid = this.asteroids.get(asteroidId);
    if (asteroid && isColossalAsteroid(asteroid.size) && asteroid.health > 0) {
      if (asteroid.boost?.phase === 'burning') {
        return { outcome: 'ignored', newAsteroids: [] };
      }
      return { outcome: 'damaged', newAsteroids: [] };
    }
    return this.finishDestroy(asteroidId, false);
  }

  /** Retain the mining history of durable deposits. */
  public recordMiningHit(asteroidId: string, minerId: string): void {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid || asteroid.boost?.phase === 'burning') {
      return;
    }
    const contributors = asteroid.miningContributors ?? [];
    if (!contributors.includes(minerId)) {
      contributors.push(minerId);
      asteroid.miningContributors = contributors;
    }
  }

  private finishDestroy(asteroidId: string, split: boolean): AsteroidHitOutcome {
    const destroyed = this.asteroids.get(asteroidId);
    if (!destroyed) {
      return { outcome: 'missing', newAsteroids: [] };
    }

    if (destroyed.boost?.phase === 'burning') {
      return { outcome: 'ignored', newAsteroids: [] };
    }

    this.removeAsteroid(asteroidId);

    const colossal = isColossalAsteroid(destroyed.size);
    const fragmentCount = colossal ? 2 : 3;
    const canSplit =
      colossal || (destroyed.material === 'rubble' && destroyed.size > this.minAsteroidSize * 2);
    const nearbyCount = this.spatialIndex()
      .query({
        minX: destroyed.position.x - WORLD.sectorSize,
        minY: destroyed.position.y - WORLD.sectorSize,
        maxX: destroyed.position.x + WORLD.sectorSize,
        maxY: destroyed.position.y + WORLD.sectorSize,
      })
      .filter(
        (rock) =>
          Math.hypot(
            rock.position.x - destroyed.position.x,
            rock.position.y - destroyed.position.y
          ) <= WORLD.sectorSize
      ).length;
    const newAsteroids =
      split && canSplit && nearbyCount + fragmentCount <= ROID.SPLIT_NEARBY_LIMIT
        ? this.createSplitFragments(destroyed)
        : [];

    for (const fragment of newAsteroids) {
      this.addAsteroid(fragment);
    }

    this.onDestroyed?.(destroyed);
    return {
      outcome: 'destroyed',
      destroyed,
      newAsteroids,
    };
  }

  private createSplitFragments(destroyed: AsteroidData): AsteroidData[] {
    const newAsteroids: AsteroidData[] = [];

    const colossal = isColossalAsteroid(destroyed.size);
    const rubble = !colossal;
    const fragmentCount = rubble ? 3 : 2;
    for (let i = 0; i < fragmentCount; i++) {
      const ratio = colossal ? this.COLOSSAL_SPLIT_SIZE_RATIO : 0.3 + i * 0.07;
      const newSize = Math.max(this.minAsteroidSize, destroyed.size * ratio);
      const offsetDistance = rubble ? newSize * 1.4 : newSize * 0.3;
      const angle = (i * Math.PI * 2) / fragmentCount + (rubble ? this.rng.random() * 0.5 : 0);
      const offsetX = Math.cos(angle) * offsetDistance;
      const offsetY = Math.sin(angle) * offsetDistance;

      const newJaggedness = Math.max(0.3, destroyed.jaggedness * 0.8);
      const newOffsets = destroyed.material
        ? MATERIAL_OUTLINES[destroyed.material].map(
            (offset) => offset * (0.94 + this.rng.random() * 0.12)
          )
        : Array.from(
            { length: Math.floor(this.rng.random() * 8 + 6) },
            () => this.rng.random() * newJaggedness * 2 + 1 - newJaggedness
          );
      const newVertices = newOffsets.length;

      newAsteroids.push({
        id: `server-asteroid-${this.managerNonce}-${this.fieldGeneration}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        position: containAsteroidPosition(
          destroyed.position.x + offsetX,
          destroyed.position.y + offsetY
        ),
        velocity: {
          x:
            destroyed.velocity.x +
            ((this.rng.random() - 0.5) * 3 + offsetX * 0.1) * GAME.MOTION_SCALE,
          y:
            destroyed.velocity.y +
            ((this.rng.random() - 0.5) * 3 + offsetY * 0.1) * GAME.MOTION_SCALE,
        },
        size: newSize,
        jaggedness: newJaggedness,
        rotation: this.rng.random() * Math.PI * 2,
        angularVelocity: (this.rng.random() - 0.5) * 0.01 * GAME.MOTION_SCALE,
        health: Math.floor(newSize * 0.8),
        maxHealth: Math.floor(newSize * 0.8),
        vertices: newVertices,
        offsets: newOffsets,
        ...(destroyed.material ? { material: destroyed.material } : {}),
        ore: oreResource(destroyed),
        surveyedBy: [...(destroyed.surveyedBy ?? [])],
      });
    }

    return newAsteroids;
  }
}
