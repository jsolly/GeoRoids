import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import { satelliteProfileAt } from '../../shared/eoSatellites';
import type { Position, SatellitePickupData } from '../../shared-types';
import { DEBUG, PALETTE, SATELLITE_PICKUP } from '../../src/constants';
import {
  attachOrbitPosition,
  orbitRadiusForOwner,
  spawnRingPosition,
  velocityFromDelta,
} from '../../src/entities/satellitePickup/satellitePickupMath';
import type { RNGService } from './RNGService';

interface PickupOwnerPose {
  id: string;
  position: Position;
  radius: number;
  health: number;
  exploding: boolean;
}

interface SatellitePickupInternal extends SatellitePickupData {
  rosterIndex: number;
  orbitPhase: number;
  respawnTimer: number;
}

export class SatellitePickupManager {
  private pickups = new Map<string, SatellitePickupInternal>();
  private rng: RNGService;

  constructor(rngService: RNGService) {
    this.rng = rngService;
  }

  public getCount(): number {
    return this.pickups.size;
  }

  public getPickup(id: string): SatellitePickupInternal | undefined {
    return this.pickups.get(id);
  }

  public getAllPickups(): SatellitePickupData[] {
    return Array.from(this.pickups.values()).map((pickup) => this.toPublic(pickup));
  }

  public clear(): void {
    this.pickups.clear();
  }

  public createPickups(count: number = SATELLITE_PICKUP.MAX_COUNT): SatellitePickupData[] {
    this.pickups.clear();
    const configuredCount = DEBUG.ENABLED ? DEBUG.SATELLITE_PICKUP.COUNT : count;
    const spawnCount = Math.min(
      Math.max(0, Math.trunc(configuredCount)),
      SATELLITE_PICKUP.MAX_COUNT
    );
    const created: SatellitePickupData[] = [];

    for (let i = 0; i < spawnCount; i++) {
      const pickup = this.spawnLoose(i, spawnCount);
      this.pickups.set(pickup.id, pickup);
      created.push(this.toPublic(pickup));
    }

    logger.info(`🛰️ Created ${created.length} satellite pickups`);
    return created;
  }

  /** Store a loose pickup until its owner chooses to deploy it. */
  public collect(pickupId: string, owner: PickupOwnerPose): SatellitePickupData | null {
    const pickup = this.pickups.get(pickupId);
    if (pickup?.state !== 'loose' || pickup.health <= 0 || owner.health <= 0 || owner.exploding) {
      return null;
    }
    pickup.state = 'stored';
    pickup.ownerId = owner.id;
    pickup.position = { ...owner.position };
    pickup.velocity = { x: 0, y: 0 };
    return this.toPublic(pickup);
  }

  public equip(pickupId: string, owner: PickupOwnerPose): SatellitePickupData | null {
    const pickup = this.pickups.get(pickupId);
    if (
      pickup?.state !== 'stored' ||
      pickup.ownerId !== owner.id ||
      owner.health <= 0 ||
      owner.exploding ||
      this.countOrbitingFor(owner.id) > 0
    ) {
      return null;
    }
    pickup.state = 'orbiting';
    pickup.ownerId = owner.id;
    pickup.orbitPhase = 0;
    const prev = { ...pickup.position };
    pickup.position = attachOrbitPosition(
      owner.position,
      pickup.orbitPhase,
      orbitRadiusForOwner(owner.radius, pickup.radius)
    );
    pickup.velocity = velocityFromDelta(prev, pickup.position);
    pickup.angle = pickup.orbitPhase;

    return this.toPublic(pickup);
  }

  /** Apply one physical hit to a live pickup. */
  public damage(pickupId: string, damage: number): SatellitePickupData | null {
    const pickup = this.pickups.get(pickupId);
    if (
      pickup?.state !== 'orbiting' ||
      pickup.health <= 0 ||
      !Number.isFinite(damage) ||
      damage <= 0
    ) {
      return null;
    }

    this.depleteHealth(pickup, damage);
    return this.toPublic(pickup);
  }

  /** Time and impacts consume the same resource, with one exhaustion transition. */
  private depleteHealth(pickup: SatellitePickupInternal, amount: number): void {
    const remaining = Math.max(0, pickup.health - amount);
    // Repeated fractional HP subtraction must still expire on the final frame.
    const roundingTolerance = Number.EPSILON * pickup.maxHealth * SATELLITE_PICKUP.LIFETIME_FRAMES;
    pickup.health = remaining <= roundingTolerance ? 0 : remaining;
    if (pickup.health === 0) {
      pickup.state = 'broken';
      pickup.ownerId = null;
      pickup.respawnTimer = SATELLITE_PICKUP.RESPAWN_FRAMES;
      pickup.velocity = { x: 0, y: 0 };
    }
  }

  public countOrbitingFor(ownerId: string) {
    let count = 0;
    for (const pickup of this.pickups.values()) {
      if (pickup.state === 'orbiting' && pickup.ownerId === ownerId) {
        count += 1;
      }
    }
    return count;
  }

  public releaseOwner(ownerId: string): void {
    for (const pickup of this.pickups.values()) {
      if (
        (pickup.state === 'orbiting' || pickup.state === 'stored') &&
        pickup.ownerId === ownerId
      ) {
        this.makeLooseAtCurrentPose(pickup);
      }
    }
  }

  public update(owners: PickupOwnerPose[]): void {
    const byId = new Map(owners.map((owner) => [owner.id, owner]));
    for (const pickup of this.pickups.values()) {
      if (pickup.state === 'stored') {
        const owner = byId.get(pickup.ownerId ?? '');
        if (!owner || owner.health <= 0 || owner.exploding) {
          this.makeLooseAtCurrentPose(pickup);
        } else {
          pickup.position = { ...owner.position };
        }
      } else if (pickup.state === 'orbiting') {
        this.updateOrbiting(pickup, byId.get(pickup.ownerId ?? ''));
      } else if (pickup.state === 'broken') {
        this.updateBroken(pickup);
      }
    }
  }

  private updateOrbiting(
    pickup: SatellitePickupInternal,
    owner: PickupOwnerPose | undefined
  ): void {
    if (!owner || owner.health <= 0 || owner.exploding) {
      this.makeLooseAtCurrentPose(pickup);
      return;
    }

    this.depleteHealth(pickup, pickup.maxHealth / SATELLITE_PICKUP.LIFETIME_FRAMES);
    if (pickup.state === 'broken') {
      return;
    }
    const prev = { ...pickup.position };
    pickup.orbitPhase += SATELLITE_PICKUP.ORBIT_SPEED;
    const orbitPosition = attachOrbitPosition(
      owner.position,
      pickup.orbitPhase,
      orbitRadiusForOwner(owner.radius, pickup.radius)
    );

    pickup.position = {
      x: orbitPosition.x,
      y: orbitPosition.y,
    };
    pickup.velocity = velocityFromDelta(prev, pickup.position);
    pickup.angle = pickup.orbitPhase;
  }

  private updateBroken(pickup: SatellitePickupInternal): void {
    pickup.respawnTimer = Math.max(0, pickup.respawnTimer - 1);
    if (pickup.respawnTimer === 0) {
      this.respawnLoose(pickup);
    }
  }

  private makeLooseAtCurrentPose(pickup: SatellitePickupInternal): void {
    pickup.state = 'loose';
    pickup.ownerId = null;
    pickup.velocity = { x: 0, y: 0 };
    pickup.respawnTimer = 0;
  }

  private respawnLoose(pickup: SatellitePickupInternal): void {
    const next = this.spawnLoose(pickup.rosterIndex, this.pickups.size, pickup.id);
    Object.assign(pickup, next);
  }

  private spawnLoose(
    index: number,
    count: number,
    id = `server-pickup-${randomUUID()}`
  ): SatellitePickupInternal {
    const profile = satelliteProfileAt(index);
    const position = spawnRingPosition(index, count, () => this.rng.random());
    const orbitPhase = this.rng.random() * Math.PI * 2;

    return {
      id,
      name: profile.displayName,
      typeId: profile.typeId,
      assetKey: profile.assetKey,
      position,
      velocity: { x: 0, y: 0 },
      angle: orbitPhase,
      radius: SATELLITE_PICKUP.SIZE / 2,
      color: PALETTE.SATELLITE,
      state: 'loose',
      ownerId: null,
      health: SATELLITE_PICKUP.HEALTH,
      maxHealth: SATELLITE_PICKUP.HEALTH,
      orbitPhase,
      rosterIndex: index,
      respawnTimer: 0,
    };
  }

  private toPublic(pickup: SatellitePickupInternal): SatellitePickupData {
    return {
      id: pickup.id,
      name: pickup.name,
      typeId: pickup.typeId,
      assetKey: pickup.assetKey,
      position: { ...pickup.position },
      velocity: { ...pickup.velocity },
      angle: pickup.angle,
      radius: pickup.radius,
      color: pickup.color,
      state: pickup.state,
      ownerId: pickup.ownerId,
      health: pickup.health,
      maxHealth: pickup.maxHealth,
    };
  }
}
