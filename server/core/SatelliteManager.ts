import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import { type SatelliteProfile, satelliteProfileAt } from '../../shared/eoSatellites';
import type {
  Position,
  SatelliteData,
  SatelliteProjectileState,
  SatelliteShoot,
} from '../../shared-types';
import { DAMAGE, DEBUG, SATELLITE } from '../../src/constants';
import {
  aimAngleToward,
  applyAimJitter,
  clampToRadius,
  distanceTo,
  figure8Offset,
  findNearestLivingTarget,
  laserStartFromAngle,
  laserVelocityFromAngle,
} from '../../src/entities/satellite/satelliteMath';
import type { RNGService } from './RNGService';

/** Targets are copied from authoritative server entities for one simulation step. */
interface SatelliteTarget {
  id: string;
  position: Position;
  radius: number;
  health: number;
  exploding: boolean;
  respawnTimer?: number;
}

export interface SatelliteHit {
  satelliteId: string;
  targetId: string;
  damage: number;
}

type SatelliteProjectile = SatelliteProjectileState;

interface SatelliteInternal extends SatelliteData {
  profile: SatelliteProfile;
  orbitCenter: Position;
  orbitPhase: number;
  orbitRadiusX: number;
  orbitRadiusY: number;
  shootCooldown: number;
  burstRemaining: number;
  burstCooldown: number;
  burstShotIndex: number;
  burstAngle: number;
  explodeTime: number;
  respawnTimer: number;
  driftAngle: number;
}

export class SatelliteManager {
  private readonly satellites = new Map<string, SatelliteInternal>();
  private readonly projectiles: SatelliteProjectile[] = [];
  private readonly rng: RNGService;
  private isCreating = false;
  private nextIndex = 0;
  private nextShotIndex = 0;
  private pendingHits: SatelliteHit[] = [];

  constructor(rngService: RNGService) {
    this.rng = rngService;
  }

  public getCount(): number {
    return this.satellites.size;
  }

  public getSatellite(id: string): SatelliteInternal | undefined {
    return this.satellites.get(id);
  }

  public getAllSatellites(): SatelliteData[] {
    return Array.from(this.satellites.values())
      .filter((satellite) => satellite.respawnTimer <= 0)
      .map((satellite) => this.toPublic(satellite));
  }

  public clearSatellites(): void {
    this.satellites.clear();
    this.projectiles.length = 0;
    this.pendingHits = [];
    this.nextIndex = 0;
    this.nextShotIndex = 0;
  }

  public createSatellitesSafely(count: number, bounds = { radius: 3100 }): SatelliteData[] | null {
    if (this.isCreating) {
      return null;
    }
    this.isCreating = true;
    try {
      if (this.getCount() === 0) {
        return this.createSatellites(count, bounds);
      }
      return this.ensureAmbient(count, bounds);
    } finally {
      this.isCreating = false;
    }
  }

  public createSatellites(count: number, bounds = { radius: 3100 }): SatelliteData[] {
    this.satellites.clear();
    this.projectiles.length = 0;
    this.pendingHits = [];
    this.nextIndex = 0;
    const configuredCount = DEBUG.ENABLED ? DEBUG.SATELLITE.COUNT : count;
    const satelliteCount = Math.min(Math.max(0, Math.trunc(configuredCount)), SATELLITE.MAX_COUNT);
    const created: SatelliteData[] = [];

    for (let i = 0; i < satelliteCount; i++) {
      const satellite = this.spawnSatellite(this.nextIndex++, bounds);
      this.satellites.set(satellite.id, satellite);
      created.push(this.toPublic(satellite));
    }

    logger.info(`🛰️ Created ${created.length} ambient hostile EO satellites`);
    return created;
  }

  public ensureAmbient(
    count: number = SATELLITE.AMBIENT_COUNT,
    bounds = { radius: 3100 }
  ): SatelliteData[] {
    const configuredCount = DEBUG.ENABLED ? DEBUG.SATELLITE.COUNT : count;
    const target = Math.min(Math.max(0, Math.trunc(configuredCount)), SATELLITE.MAX_COUNT);
    const created: SatelliteData[] = [];
    while (this.satellites.size < target) {
      const satellite = this.spawnSatellite(this.nextIndex++, bounds);
      this.satellites.set(satellite.id, satellite);
      created.push(this.toPublic(satellite));
    }
    return created;
  }

  public damageSatellite(satelliteId: string, damage: number): SatelliteInternal | undefined {
    const satellite = this.satellites.get(satelliteId);
    if (
      !satellite ||
      !Number.isFinite(damage) ||
      damage <= 0 ||
      satellite.exploding ||
      satellite.respawnTimer > 0 ||
      satellite.health <= 0
    ) {
      return undefined;
    }

    satellite.health = Math.max(0, satellite.health - damage);
    if (satellite.health <= 0) {
      satellite.exploding = true;
      satellite.explodeTime = SATELLITE.EXPLODE_DURATION_FRAMES;
      this.removeProjectilesFor(satellite.id);
    }
    return satellite;
  }

  /** Advance authoritative motion and return only newly-created visual shots. */
  public update(targets: SatelliteTarget[]): SatelliteShoot[] {
    this.pendingHits = this.advanceProjectiles(targets);
    const shots: SatelliteShoot[] = [];
    for (const satellite of this.satellites.values()) {
      const shot = this.updateOne(satellite, targets);
      if (shot) {
        shots.push(shot);
      }
    }
    return shots;
  }

  public drainHits(): SatelliteHit[] {
    const hits = this.pendingHits;
    this.pendingHits = [];
    return hits;
  }

  /** Return a copied keyframe view of every still-live EO projectile. */
  public getActiveProjectiles(): SatelliteProjectileState[] {
    return this.projectiles.map((projectile) => ({
      satelliteId: projectile.satelliteId,
      shotId: projectile.shotId,
      position: { ...projectile.position },
      velocity: { ...projectile.velocity },
      age: projectile.age,
    }));
  }

  private advanceProjectiles(targets: SatelliteTarget[]): SatelliteHit[] {
    const hits: SatelliteHit[] = [];
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      if (!projectile) {
        continue;
      }
      projectile.position = {
        x: projectile.position.x + projectile.velocity.x,
        y: projectile.position.y + projectile.velocity.y,
      };
      projectile.age += 1;
      if (projectile.age > SATELLITE.PROJECTILE_MAX_FRAMES) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const target = targets.find(
        (candidate) =>
          !candidate.exploding &&
          candidate.health > 0 &&
          candidate.respawnTimer === undefined &&
          distanceTo(projectile.position, candidate.position) <= candidate.radius + 4
      );
      if (!target) {
        continue;
      }
      hits.push({
        satelliteId: projectile.satelliteId,
        targetId: target.id,
        damage: DAMAGE.LASER_HIT,
      });
      this.projectiles.splice(i, 1);
    }
    return hits;
  }

  private updateOne(
    satellite: SatelliteInternal,
    targets: SatelliteTarget[]
  ): SatelliteShoot | null {
    if (satellite.exploding) {
      satellite.explodeTime -= 1;
      if (satellite.explodeTime <= 0) {
        satellite.exploding = false;
        satellite.health = satellite.maxHealth;
        satellite.respawnTimer = SATELLITE.RESPAWN_FRAMES;
        this.repositionNearTargets(satellite, targets);
      }
      return null;
    }

    if (satellite.respawnTimer > 0) {
      satellite.respawnTimer -= 1;
      return null;
    }

    const living = targets.filter(
      (target) => !target.exploding && target.health > 0 && target.respawnTimer === undefined
    );
    if (living.length > 0) {
      let nearestDist = Number.POSITIVE_INFINITY;
      for (const target of living) {
        nearestDist = Math.min(nearestDist, distanceTo(satellite.position, target.position));
      }
      if (nearestDist > SATELLITE.DESPAWN_DISTANCE) {
        this.repositionNearTargets(satellite, living);
      }
    }

    if (DEBUG.ENABLED && !DEBUG.SATELLITE.MOVEMENT) {
      // Debug can freeze the orbit for inspection without changing production.
    } else {
      this.advanceOrbit(satellite);
    }

    const nearest = findNearestLivingTarget(satellite.position, living);
    if (nearest) {
      satellite.angle = aimAngleToward(satellite.position, nearest.position);
    }

    if (DEBUG.ENABLED && !DEBUG.SATELLITE.LASERS) {
      return null;
    }
    if (!nearest) {
      return null;
    }

    satellite.shootCooldown -= 1;
    satellite.burstCooldown -= 1;
    if (satellite.burstRemaining > 0) {
      if (satellite.burstCooldown > 0) {
        return null;
      }
      const shot = this.createShot(satellite, satellite.burstShotIndex);
      satellite.burstShotIndex += 1;
      satellite.burstRemaining -= 1;
      satellite.burstCooldown = satellite.profile.burstGapFrames;
      if (satellite.burstRemaining <= 0) {
        satellite.shootCooldown = satellite.profile.cadenceFrames;
        satellite.burstShotIndex = 0;
      }
      return shot;
    }
    if (satellite.shootCooldown > 0) {
      return null;
    }

    satellite.burstRemaining = Math.max(0, satellite.profile.burstCount - 1);
    satellite.burstCooldown = satellite.profile.burstGapFrames;
    satellite.burstShotIndex = 1;
    satellite.burstAngle = satellite.angle;
    const shot = this.createShot(satellite, 0);
    if (satellite.burstRemaining <= 0) {
      satellite.shootCooldown = satellite.profile.cadenceFrames;
      satellite.burstShotIndex = 0;
    }
    return shot;
  }

  private createShot(satellite: SatelliteInternal, burstShotIndex: number): SatelliteShoot {
    const center = (satellite.profile.burstCount - 1) / 2;
    let burstOffset = 0;
    switch (satellite.profile.shotPattern) {
      case 'wide-sweep':
        burstOffset = (burstShotIndex - center) * satellite.profile.spreadRadians;
        break;
      case 'spin-burst':
        burstOffset = (burstShotIndex * Math.PI * 2) / satellite.profile.burstCount;
        break;
      case 'radar-sweep':
        burstOffset = (center - burstShotIndex) * satellite.profile.spreadRadians;
        break;
      case 'steady':
      case 'weather-beam':
      case 'precision-stab':
        break;
    }
    const aimed = applyAimJitter(
      satellite.burstAngle + burstOffset,
      satellite.profile.aimJitter,
      () => this.rng.random()
    );
    const laserStart = laserStartFromAngle(satellite.position, aimed, satellite.radius);
    const laserDirection = laserVelocityFromAngle(
      aimed,
      satellite.velocity,
      satellite.profile.speedMultiplier
    );
    const shotId = `${satellite.id}-shot-${this.nextShotIndex++}`;
    this.projectiles.push({
      satelliteId: satellite.id,
      shotId,
      position: { ...laserStart },
      velocity: { ...laserDirection },
      age: 0,
    });
    return { id: satellite.id, shotId, laserStart, laserDirection };
  }

  private advanceOrbit(satellite: SatelliteInternal): void {
    const prev = { x: satellite.position.x, y: satellite.position.y };
    satellite.orbitCenter.x += Math.cos(satellite.driftAngle) * SATELLITE.DRIFT_SPEED;
    satellite.orbitCenter.y += Math.sin(satellite.driftAngle) * SATELLITE.DRIFT_SPEED;
    satellite.orbitCenter = clampToRadius(satellite.orbitCenter, SATELLITE.BOUNDARY_RADIUS);

    const centerDist = Math.hypot(satellite.orbitCenter.x, satellite.orbitCenter.y);
    if (centerDist > SATELLITE.BOUNDARY_RADIUS - 80) {
      satellite.driftAngle = Math.atan2(-satellite.orbitCenter.y, -satellite.orbitCenter.x);
    }

    satellite.orbitPhase += SATELLITE.ORBIT_SPEED;
    const offset = figure8Offset(
      satellite.orbitPhase,
      satellite.orbitRadiusX,
      satellite.orbitRadiusY
    );
    satellite.position = clampToRadius(
      {
        x: satellite.orbitCenter.x + offset.x,
        y: satellite.orbitCenter.y + offset.y,
      },
      SATELLITE.BOUNDARY_RADIUS
    );
    satellite.velocity = {
      x: satellite.position.x - prev.x,
      y: satellite.position.y - prev.y,
    };
  }

  private repositionNearTargets(satellite: SatelliteInternal, targets: SatelliteTarget[]): void {
    const living = targets.filter(
      (target) => !target.exploding && target.health > 0 && target.respawnTimer === undefined
    );
    if (living.length > 0) {
      const pick = living[Math.floor(this.rng.random() * living.length)];
      if (pick) {
        const angle = this.rng.random() * Math.PI * 2;
        const radius = 220 + this.rng.random() * 180;
        satellite.orbitCenter = clampToRadius(
          {
            x: pick.position.x + Math.cos(angle) * radius,
            y: pick.position.y + Math.sin(angle) * radius,
          },
          SATELLITE.BOUNDARY_RADIUS * 0.7
        );
      }
    } else {
      satellite.orbitCenter = this.rng.randomPosition({ radius: SATELLITE.BOUNDARY_RADIUS });
    }
    satellite.orbitPhase = this.rng.random() * Math.PI * 2;
    const offset = figure8Offset(
      satellite.orbitPhase,
      satellite.orbitRadiusX,
      satellite.orbitRadiusY
    );
    satellite.position = clampToRadius(
      {
        x: satellite.orbitCenter.x + offset.x,
        y: satellite.orbitCenter.y + offset.y,
      },
      SATELLITE.BOUNDARY_RADIUS
    );
    satellite.velocity = { x: 0, y: 0 };
    satellite.shootCooldown = satellite.profile.cadenceFrames;
    satellite.burstRemaining = 0;
    satellite.burstCooldown = 0;
    satellite.burstShotIndex = 0;
  }

  private spawnSatellite(index: number, bounds: { radius: number }): SatelliteInternal {
    const profile = satelliteProfileAt(index);
    const orbitCenter = this.rng.randomPosition({
      radius: Math.min(bounds.radius, SATELLITE.BOUNDARY_RADIUS),
    });
    const orbitPhase = this.rng.random() * Math.PI * 2;
    const orbitRadiusX = SATELLITE.ORBIT_RADIUS;
    const orbitRadiusY = SATELLITE.ORBIT_RADIUS * 0.55;
    const offset = figure8Offset(orbitPhase, orbitRadiusX, orbitRadiusY);
    const position = clampToRadius(
      { x: orbitCenter.x + offset.x, y: orbitCenter.y + offset.y },
      SATELLITE.BOUNDARY_RADIUS
    );

    return {
      id: `server-sat-${randomUUID()}`,
      name: profile.displayName,
      typeId: profile.typeId,
      assetKey: profile.assetKey,
      shotManner: profile.shotManner,
      position,
      velocity: { x: 0, y: 0 },
      angle: 0,
      exploding: false,
      color: profile.hullColor,
      health: SATELLITE.HEALTH,
      maxHealth: SATELLITE.HEALTH,
      radius: SATELLITE.SIZE / 2,
      profile,
      orbitCenter,
      orbitPhase,
      orbitRadiusX,
      orbitRadiusY,
      shootCooldown: profile.cadenceFrames + (index % 5) * 9,
      burstRemaining: 0,
      burstCooldown: 0,
      burstShotIndex: 0,
      burstAngle: 0,
      explodeTime: 0,
      respawnTimer: 0,
      driftAngle: this.rng.random() * Math.PI * 2,
    };
  }

  private removeProjectilesFor(satelliteId: string): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i]?.satelliteId === satelliteId) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  private toPublic(satellite: SatelliteInternal): SatelliteData {
    return {
      id: satellite.id,
      name: satellite.name,
      typeId: satellite.typeId,
      assetKey: satellite.assetKey,
      shotManner: satellite.shotManner,
      position: { ...satellite.position },
      velocity: { ...satellite.velocity },
      angle: satellite.angle,
      exploding: satellite.exploding,
      color: satellite.color,
      health: satellite.health,
      maxHealth: satellite.maxHealth,
      radius: satellite.radius,
    };
  }
}
