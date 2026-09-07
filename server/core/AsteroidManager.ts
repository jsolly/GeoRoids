import { randomUUID } from 'node:crypto';
import type { ActiveCollabTag, AsteroidData, Position } from '../../shared-types';
import { asteroidMaterialAt, MATERIAL_OUTLINES } from '../../shared/asteroidMaterials';
import { DAMAGE, DEBUG, ROID } from '../../src/constants';
import { isBiggestAsteroid, pointsForRoidSize } from '../../src/entities/roid/roidScore';
import { getAsteroidFieldRadius, stepAsteroidMotion } from '../../src/physics/asteroidMotion';
import { applyShockwaveToBody } from '../../src/physics/shockwave';
import { isDebugMode } from '../../src/utils/debugUtils';
import { logger } from '../../setup/serverLogger';
import { RNGService } from './RNGService';

export { isBiggestAsteroid } from '../../src/entities/roid/roidScore';

export type AsteroidHitCause = 'laser' | 'collision';

export type AsteroidHitOutcome = {
  outcome: 'missing' | 'tagged' | 'ignored' | 'destroyed';
  destroyed?: AsteroidData;
  newAsteroids: AsteroidData[];
  split: boolean;
  expiresAt?: number;
};

export type ExpiredCollabHit = {
  playerId: string;
  points: number;
  destroyed: AsteroidData;
  newAsteroids: AsteroidData[];
};

type LaserHitRecord = {
  shooterId: string;
  at: number;
  points: number;
};

export class AsteroidManager {
  private asteroids = new Map<string, AsteroidData>();
  private laserHits = new Map<string, LaserHitRecord[]>();
  private rng: RNGService;
  /** Per-manager identity prevents delayed reports surviving a server restart. */
  private readonly managerNonce = randomUUID();
  /** Monotonic field generation; never reused after a clear in this manager. */
  private fieldGeneration = 0;
  
  // Asteroid splitting constants - can be overridden by DEBUG settings
  private readonly MIN_ASTEROID_SIZE = 10;
  private readonly SPLIT_SIZE_RATIO = 0.6; // New asteroids are 60% of original size
  private readonly MAX_ASTEROID_COUNT = 200; // Prevent too many asteroids

  constructor(rngService: RNGService) {
    this.rng = rngService;
  }

  // Getter methods for asteroid configuration
  private get minAsteroidSize(): number {
    return this.MIN_ASTEROID_SIZE;
  }

  private get splitSizeRatio(): number {
    return this.SPLIT_SIZE_RATIO;
  }

  private get maxAsteroidCount(): number {
    return this.MAX_ASTEROID_COUNT;
  }

  public addAsteroid(asteroid: AsteroidData): void {
    this.asteroids.set(asteroid.id, asteroid);
  }

  public removeAsteroid(asteroidId: string): AsteroidData | undefined {
    const asteroid = this.asteroids.get(asteroidId);
    if (asteroid) {
      this.asteroids.delete(asteroidId);
      this.laserHits.delete(asteroidId);
    }
    return asteroid;
  }

  public updateAsteroid(asteroidId: string, updates: Partial<AsteroidData>): AsteroidData | undefined {
    const asteroid = this.asteroids.get(asteroidId);
    if (asteroid) {
      Object.assign(asteroid, updates);
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

  /** Return live collab tags without mutating the server's expiry clock. */
  public getActiveCollabTags(now = Date.now()): ActiveCollabTag[] {
    const active: ActiveCollabTag[] = [];
    for (const [asteroidId, hits] of this.laserHits) {
      const asteroid = this.asteroids.get(asteroidId);
      if (!asteroid) {
        continue;
      }
      const windowHits = hits.filter((hit) => now - hit.at <= ROID.COLLAB_SPLIT_WINDOW_MS);
      const first = windowHits[0];
      if (!first) {
        continue;
      }
      active.push({
        asteroidId,
        hits: windowHits.map((hit) => ({ ...hit })),
        expiresAt: first.at + ROID.COLLAB_SPLIT_WINDOW_MS,
      });
    }
    return active;
  }

  public clearAsteroids(): void {
    this.asteroids.clear();
    this.laserHits.clear();
  }

  /**
   * Advance every asteroid one simulation frame (same units as client `moveRoids`:
   * velocity is pixels per 60 FPS tick). Debug placement modes stay frozen so
   * collision tests that pin roids on ships/bots do not drift.
   */
  public updateMotion(): void {
    if (DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER || DEBUG.ROIDS.PLACE_ON_BOT) {
      return;
    }

    for (const asteroid of this.asteroids.values()) {
      const next = stepAsteroidMotion(asteroid.position, asteroid.velocity);
      asteroid.position = next.position;
      asteroid.velocity = next.velocity;
      asteroid.rotation += asteroid.angularVelocity;
    }
  }

  /** Radial kick from a collab-split shockwave. Smaller roids move more. */
  public applyRadialImpulse(
    origin: Position,
    radius: number,
    impulse: number
  ): number {
    let affected = 0;
    for (const asteroid of this.asteroids.values()) {
      const next = applyShockwaveToBody(
        { position: asteroid.position, velocity: asteroid.velocity, size: asteroid.size },
        origin,
        { radius, impulse }
      );
      if (next) {
        asteroid.velocity = next;
        affected += 1;
      }
    }
    return affected;
  }

  public createAsteroids(
    count: number,
    bounds = { radius: getAsteroidFieldRadius() },
    botPositions: Position[] = [],
    playerPositions: Position[] = []
  ): AsteroidData[] {
    // If we already have asteroids and no player positions are provided, return them instead of recreating
    // But if player positions are provided, we should recreate to place roids on players
    // Also recreate if we're in test mode (PLACE_ON_LOCAL_PLAYER is true)
    const isTestMode = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
    logger.debug('AsteroidManager: isTestMode =', isTestMode, 'playerPositions.length =', playerPositions.length, 'existing asteroids =', this.asteroids.size);
    if (this.asteroids.size > 0 && playerPositions.length === 0 && !isTestMode) {
      logger.debug('AsteroidManager: Returning existing asteroids instead of recreating');
      return Array.from(this.asteroids.values());
    }

    // Clear existing asteroids only if we're creating new ones
    this.asteroids.clear();
    this.laserHits.clear();

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
        logger.debug('Placing asteroid on player', { index: i, position });
      } else if (DEBUG.ROIDS.PLACE_ON_BOT && botPositions.length > 0) {
        // Place all asteroids on bots when PLACE_ON_BOT is true
        const botPos = botPositions[i % botPositions.length];
        position = botPos ?? this.rng.randomPosition(bounds);
        logger.debug('Placing asteroid on bot', { index: i, position });
      } else {
        position = this.rng.randomPosition(bounds);
        logger.debug('Placing asteroid randomly', { index: i, position });
      }
      
      const velocity = this.rng.randomVelocity(4);

      const material = asteroidMaterialAt(i);
      const healthValue = DAMAGE.LASER_HIT * (material === 'metal' ? 3 : 1);
      const jaggedness = material === 'rubble' ? 0.7 : 0.25;
      const offsets = MATERIAL_OUTLINES[material].map((offset) => offset * (0.96 + this.rng.random() * 0.08));
      const vertices = offsets.length;

      // Determine size based on DEBUG settings
      let size: number;
      // Check if we're in test mode (when PLACE_ON_LOCAL_PLAYER is true, assume test mode)
      const isTestMode = DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER;
      
      if (DEBUG.ENABLED && DEBUG.ROIDS.ALL_LARGE && !isTestMode) {
        size = 50; // Large size
      } else if (isTestMode) {
        // In test mode, create medium asteroids (size 20-30). Only the biggest
        // class (>= COLLAB_SPLIT_MIN_SIZE) can split, and only via collab hits.
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
        angularVelocity: (this.rng.random() - 0.5) * 0.01, // Angular velocity between -0.005 and 0.005 (matches client)
        health: healthValue,
        maxHealth: healthValue,
        vertices,
        offsets,
        material,
      };

      // One voluntary coop rock in live fields. Test placement (on-player) stays one-shot.
      if (i === 0 && !DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER) {
        asteroid.size = Math.max(asteroid.size, ROID.COLLAB_SPLIT_MIN_SIZE);
        asteroid.isCollabTarget = true;
        asteroid.health = 100;
        asteroid.maxHealth = 100;
      }

      this.asteroids.set(asteroidId, asteroid);
      newAsteroids.push(asteroid);
    }
    
    return newAsteroids;
  }

  public damageAsteroid(asteroidId: string, damage: number): AsteroidData | null {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) {
      return null;
    }

    asteroid.health = Math.max(0, asteroid.health - damage);
    return asteroid;
  }

  /**
   * Record a laser hit from any ship (player or bot). Biggest asteroids only
   * split when two distinct shooters land within COLLAB_SPLIT_WINDOW_MS.
   * A second hit from the same shooter destroys without splitting.
   * Same-shooter echoes inside COLLAB_HIT_DEDUPE_MS are ignored.
   */
  public registerLaserHit(
    asteroidId: string,
    shooterId: string,
    now = Date.now()
  ): AsteroidHitOutcome {
    const asteroid = this.asteroids.get(asteroidId);
    if (!asteroid) {
      return { outcome: 'missing', newAsteroids: [], split: false };
    }

    // Metal chips remain present until three canonical hits have landed. This
    // does not enter the cooperative tag-expiry table: waiting never kills it.
    if (asteroid.material === 'metal') {
      asteroid.health = Math.max(0, asteroid.health - DAMAGE.LASER_HIT);
      if (asteroid.health > 0) {
        return { outcome: 'tagged', newAsteroids: [], split: false, expiresAt: now + 150 };
      }
      return this.finishDestroy(asteroidId, false);
    }

    if (asteroid.material === 'rubble') {
      return this.finishDestroy(asteroidId, asteroid.size > this.minAsteroidSize * 2);
    }

    if (!isBiggestAsteroid(asteroid.size)) {
      return this.finishDestroy(asteroidId, false);
    }

    const existing = this.laserHits.get(asteroidId) ?? [];
    const windowHits = existing.filter((hit) => now - hit.at <= ROID.COLLAB_SPLIT_WINDOW_MS);
    const lastFromShooter = [...windowHits].reverse().find((hit) => hit.shooterId === shooterId);
    if (lastFromShooter && now - lastFromShooter.at <= ROID.COLLAB_HIT_DEDUPE_MS) {
      return {
        outcome: 'ignored',
        newAsteroids: [],
        split: false,
        expiresAt: lastFromShooter.at + ROID.COLLAB_SPLIT_WINDOW_MS,
      };
    }

    const recorded = this.recordHit(asteroidId, shooterId, pointsForRoidSize(asteroid.size), now);
    const distinctShooters = new Set(recorded.map((hit) => hit.shooterId));

    if (distinctShooters.size >= 2) {
      return this.finishDestroy(asteroidId, true);
    }

    const shotsByThisShooter = recorded.filter((hit) => hit.shooterId === shooterId);
    if (shotsByThisShooter.length >= 2) {
      return this.finishDestroy(asteroidId, false);
    }

    const first = recorded[0];
    return {
      outcome: 'tagged',
      newAsteroids: [],
      split: false,
      expiresAt: (first?.at ?? now) + ROID.COLLAB_SPLIT_WINDOW_MS,
    };
  }

  /** Ship-ram / non-laser destroy: never splits. */
  public destroyFromCollision(asteroidId: string): AsteroidHitOutcome {
    return this.finishDestroy(asteroidId, false);
  }

  /**
   * After the collab window closes with only one shooter, the tagged biggest
   * asteroid is destroyed without splitting.
   */
  public expireStaleHits(now = Date.now()): ExpiredCollabHit[] {
    const expired: ExpiredCollabHit[] = [];
    const staleIds: string[] = [];

    for (const [asteroidId, hits] of this.laserHits) {
      const windowHits = hits.filter((hit) => now - hit.at <= ROID.COLLAB_SPLIT_WINDOW_MS);
      if (windowHits.length > 0) {
        this.laserHits.set(asteroidId, windowHits);
      } else {
        staleIds.push(asteroidId);
      }
    }

    for (const asteroidId of staleIds) {
      const hits = this.laserHits.get(asteroidId);
      const lastHit = hits?.[hits.length - 1];
      const result = this.finishDestroy(asteroidId, false);
      if (result.destroyed && lastHit) {
        expired.push({
          playerId: lastHit.shooterId,
          points: lastHit.points,
          destroyed: result.destroyed,
          newAsteroids: result.newAsteroids,
        });
      }
    }

    return expired;
  }

  /**
   * Destroys an asteroid. Splits only when `split` is true, the asteroid is
   * biggest-class, and the field is under the cap.
   */
  public destroyAsteroid(
    asteroidId: string,
    options?: { split?: boolean }
  ): { destroyed: AsteroidData | undefined; newAsteroids: AsteroidData[] } {
    const result = this.finishDestroy(asteroidId, options?.split === true);
    return { destroyed: result.destroyed, newAsteroids: result.newAsteroids };
  }

  private recordHit(asteroidId: string, shooterId: string, points: number, now: number): LaserHitRecord[] {
    const existing = this.laserHits.get(asteroidId) ?? [];
    const windowHits = existing.filter((hit) => now - hit.at <= ROID.COLLAB_SPLIT_WINDOW_MS);
    windowHits.push({ shooterId, at: now, points });
    this.laserHits.set(asteroidId, windowHits);
    return windowHits;
  }

  private finishDestroy(asteroidId: string, split: boolean): AsteroidHitOutcome {
    const destroyed = this.asteroids.get(asteroidId);
    if (!destroyed) {
      this.laserHits.delete(asteroidId);
      return { outcome: 'missing', newAsteroids: [], split: false };
    }

    this.asteroids.delete(asteroidId);
    this.laserHits.delete(asteroidId);

    const fragmentCount = destroyed.material === 'rubble' ? 3 : 2;
    const canSplit = destroyed.material === 'rubble'
      ? destroyed.size > this.minAsteroidSize * 2
      : isBiggestAsteroid(destroyed.size);
    const newAsteroids =
      split && canSplit && this.asteroids.size + fragmentCount <= this.maxAsteroidCount
        ? this.createSplitFragments(destroyed)
        : [];

    for (const fragment of newAsteroids) {
      this.asteroids.set(fragment.id, fragment);
    }

    return {
      outcome: 'destroyed',
      destroyed,
      newAsteroids,
      split: newAsteroids.length > 0,
    };
  }

  private createSplitFragments(destroyed: AsteroidData): AsteroidData[] {
    const newAsteroids: AsteroidData[] = [];

    const rubble = destroyed.material === 'rubble';
    const fragmentCount = rubble ? 3 : 2;
    for (let i = 0; i < fragmentCount; i++) {
      const ratio = rubble ? 0.3 + i * 0.07 : this.splitSizeRatio;
      const newSize = Math.max(this.minAsteroidSize, destroyed.size * ratio);
      const offsetDistance = rubble ? newSize * 1.4 : newSize * 0.3;
      const angle = i * Math.PI * 2 / fragmentCount + (rubble ? this.rng.random() * 0.5 : 0);
      const offsetX = Math.cos(angle) * offsetDistance;
      const offsetY = Math.sin(angle) * offsetDistance;

      const newJaggedness = Math.max(0.3, destroyed.jaggedness * 0.8);
      const newOffsets = destroyed.material
        ? MATERIAL_OUTLINES[destroyed.material].map((offset) => offset * (0.94 + this.rng.random() * 0.12))
        : Array.from({ length: Math.floor(this.rng.random() * 8 + 6) }, () => this.rng.random() * newJaggedness * 2 + 1 - newJaggedness);
      const newVertices = newOffsets.length;

      newAsteroids.push({
        id: `server-asteroid-${this.managerNonce}-${this.fieldGeneration}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        position: {
          x: destroyed.position.x + offsetX,
          y: destroyed.position.y + offsetY,
        },
        velocity: {
          x: destroyed.velocity.x + (this.rng.random() - 0.5) * 3 + offsetX * 0.1,
          y: destroyed.velocity.y + (this.rng.random() - 0.5) * 3 + offsetY * 0.1,
        },
        size: newSize,
        jaggedness: newJaggedness,
        rotation: this.rng.random() * Math.PI * 2,
        angularVelocity: (this.rng.random() - 0.5) * 0.01,
        health: Math.floor(newSize * 0.8),
        maxHealth: Math.floor(newSize * 0.8),
        vertices: newVertices,
        offsets: newOffsets,
        ...(destroyed.material ? { material: destroyed.material } : {}),
      });
    }

    return newAsteroids;
  }
}
