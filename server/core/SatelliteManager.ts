import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import { ASTEROID_INTERACTIONS, segmentCircleContact } from '../../shared/asteroidPhenomena';
import { type SatelliteProfile, satelliteProfileAt } from '../../shared/eoSatellites';
import {
  findNearestShieldImpact,
  reflectProjectileVelocity,
  type ShieldReflectionBody,
} from '../../shared/shieldReflection';
import type {
  Position,
  SatelliteData,
  SatelliteProjectileState,
  SatelliteShoot,
} from '../../shared-types';
import { DAMAGE, DEBUG, SATELLITE, SHIELD } from '../../src/constants';
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
import { applyQuakeImpulse } from '../../src/entities/ship/quakeImpulse';
import {
  advanceQuakeMotion,
  applyQuakeMotion,
  clearQuakeMotion,
  createQuakeMotion,
  type QuakeMotion,
} from './quakeMotion';
import type { RNGService } from './RNGService';

/** Targets are copied from authoritative server entities for one simulation step. */
interface SatelliteTarget {
  id: string;
  position: Position;
  radius: number;
  health: number;
  exploding: boolean;
  respawnTimer?: number;
  /** Pickups are interceptable bodies, but EO satellites never aim at them. */
  aimable?: boolean;
  kind?: 'ship' | 'pickup' | 'satellite';
  /** The F surface and projected E surface are both laser-reflecting. */
  shieldActive?: boolean;
  shieldTime?: number;
  shieldTimer?: number;
  /** Lets GameEngine update the readable shield flash without serializing a callback. */
  onShieldHit?: () => void;
}

export interface SatelliteHit {
  satelliteId: string;
  targetId: string;
  targetKind: 'ship' | 'pickup' | 'satellite';
  damage: number;
}

type SatelliteProjectile = SatelliteProjectileState & {
  bounces: number;
  lastShieldId?: string;
};

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
  quakeMotion: QuakeMotion;
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

  /** Apply Quake to live NPC satellites and every active satellite projectile. */
  public applyQuakePulse(origin: Position, fallbackAngle = 0): number {
    let affected = 0;
    for (const satellite of this.satellites.values()) {
      if (
        satellite.exploding ||
        satellite.respawnTimer > 0 ||
        !applyQuakeMotion(satellite, satellite.quakeMotion, origin, fallbackAngle)
      ) {
        continue;
      }
      affected += 1;
    }
    for (const projectile of this.projectiles) {
      if (applyQuakeImpulse(projectile, origin, fallbackAngle)) {
        affected += 1;
      }
    }
    return affected;
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
    const aimableTargets = targets.filter((target) => target.aimable !== false);
    const shots: SatelliteShoot[] = [];
    for (const satellite of this.satellites.values()) {
      const shot = this.updateOne(satellite, aimableTargets);
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
      let start = { ...projectile.position };
      let end = {
        x: projectile.position.x + projectile.velocity.x,
        y: projectile.position.y + projectile.velocity.y,
      };
      projectile.age += 1;
      if (projectile.age > SATELLITE.PROJECTILE_MAX_FRAMES) {
        this.projectiles.splice(i, 1);
        continue;
      }

      let removed = false;
      for (let bounceWork = 0; bounceWork <= ASTEROID_INTERACTIONS.maxBounces; bounceWork++) {
        const distance = distanceTo(start, end);
        const shieldBodies = this.getShieldBodies(targets);
        const shieldImpact = findNearestShieldImpact(
          start,
          end,
          shieldBodies,
          projectile.lastShieldId
        );
        const target = targets
          .flatMap((candidate) => {
            if (
              !this.isLiveTarget(candidate) ||
              (projectile.bounces === 0 && candidate.id === projectile.satelliteId)
            ) {
              return [];
            }
            const fraction = segmentCircleContact(
              start,
              end,
              candidate.position,
              candidate.radius + 4
            );
            return fraction === undefined
              ? []
              : [
                  {
                    candidate,
                    distance: fraction * distance,
                  },
                ];
          })
          .sort(
            (left, right) =>
              left.distance - right.distance || left.candidate.id.localeCompare(right.candidate.id)
          )[0];

        // A direct EO shot can also begin inside the larger shield bubble. An
        // outward path must clear the surface before hull contact is tested;
        // an inward path is returned as an immediate shield impact below.
        const originShield = shieldBodies.find((shield) => {
          const dx = start.x - shield.position.x;
          const dy = start.y - shield.position.y;
          return dx * dx + dy * dy < shield.radius * shield.radius;
        });
        const originRadial = originShield
          ? {
              x: start.x - originShield.position.x,
              y: start.y - originShield.position.y,
            }
          : undefined;
        const originMovingOutward =
          originShield &&
          originRadial &&
          originRadial.x * (end.x - start.x) + originRadial.y * (end.y - start.y) >= 0;
        if (originMovingOutward && originShield && distance > 1e-7) {
          if (!shieldImpact || shieldImpact.shieldId !== originShield.id) {
            projectile.position = end;
            break;
          }
          const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y);
          if (speed <= 1e-9) {
            projectile.position = end;
            break;
          }
          const remaining = Math.max(0, distance - shieldImpact.distance);
          const direction = {
            x: projectile.velocity.x / speed,
            y: projectile.velocity.y / speed,
          };
          projectile.position = { ...shieldImpact.point };
          projectile.lastShieldId = originShield.id;
          start = {
            x: shieldImpact.point.x + direction.x * 1e-5,
            y: shieldImpact.point.y + direction.y * 1e-5,
          };
          end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
          continue;
        }

        if (
          shieldImpact &&
          (!target || shieldImpact.distance <= target.distance) &&
          projectile.bounces < ASTEROID_INTERACTIONS.maxBounces
        ) {
          const shield = targets.find((candidate) => candidate.id === shieldImpact.shieldId);
          shield?.onShieldHit?.();
          projectile.position = { ...shieldImpact.point };
          projectile.velocity = reflectProjectileVelocity(projectile.velocity, shieldImpact.normal);
          projectile.bounces += 1;
          projectile.lastShieldId = shieldImpact.shieldId;
          const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y);
          if (speed <= 1e-9) {
            this.projectiles.splice(i, 1);
            removed = true;
            break;
          }
          const remaining = Math.max(0, distance - shieldImpact.distance);
          const direction = { x: projectile.velocity.x / speed, y: projectile.velocity.y / speed };
          start = {
            x: shieldImpact.point.x + direction.x * 1e-5,
            y: shieldImpact.point.y + direction.y * 1e-5,
          };
          end = { x: start.x + direction.x * remaining, y: start.y + direction.y * remaining };
          continue;
        }
        if (shieldImpact && (!target || shieldImpact.distance <= target.distance)) {
          projectile.position = { ...shieldImpact.point };
          this.projectiles.splice(i, 1);
          removed = true;
          break;
        }
        if (target) {
          hits.push({
            satelliteId: projectile.satelliteId,
            targetId: target.candidate.id,
            targetKind: target.candidate.kind ?? 'ship',
            damage: DAMAGE.LASER_HIT,
          });
          this.projectiles.splice(i, 1);
          removed = true;
          break;
        }
        projectile.position = end;
        break;
      }
      if (removed) {
      }
    }
    return hits;
  }

  private isLiveTarget(target: SatelliteTarget): boolean {
    return !target.exploding && target.health > 0 && target.respawnTimer === undefined;
  }

  private getShieldBodies(targets: readonly SatelliteTarget[]): ShieldReflectionBody[] {
    return targets
      .filter(
        (target) =>
          this.isLiveTarget(target) &&
          (target.shieldTimer !== undefined && target.shieldTimer > 0
            ? true
            : target.shieldActive === true &&
              (target.shieldTime === undefined || target.shieldTime > 0))
      )
      .map((target) => ({
        id: target.id,
        position: target.position,
        radius: target.radius * SHIELD.RADIUS_RATIO,
      }));
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
      bounces: 0,
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
    advanceQuakeMotion(satellite.quakeMotion);
    satellite.position = clampToRadius(
      {
        x: satellite.orbitCenter.x + offset.x + satellite.quakeMotion.offset.x,
        y: satellite.orbitCenter.y + offset.y + satellite.quakeMotion.offset.y,
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
    clearQuakeMotion(satellite.quakeMotion);
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
      quakeMotion: createQuakeMotion(),
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
