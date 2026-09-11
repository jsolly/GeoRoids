import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import type { Position, SatellitePickupData, SatellitePickupTypeId } from '../../shared-types';
import { DEBUG, PALETTE, SATELLITE_PICKUP } from '../../src/constants';
import {
  advanceDriftCenter,
  attachOrbitPosition,
  clampToRadius,
  orbitOffset,
  orbitRadiusForOwner,
  spawnRingPosition,
  velocityFromDelta,
} from '../../src/entities/satellitePickup/satellitePickupMath';
import type { RNGService } from './RNGService';

const PICKUP_NAMES = ['Echo', 'Relay'] as const;

interface PickupOwnerPose {
  id: string;
  position: Position;
  radius: number;
  health: number;
  exploding: boolean;
}

interface SatellitePickupInternal extends SatellitePickupData {
  rosterIndex: number;
  orbitCenter: Position;
  orbitPhase: number;
  driftAngle: number;
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

  /** Attach a loose pickup to one authoritative living human. */
  public collect(
    pickupId: string,
    owner: PickupOwnerPose,
    orbitPhase: number
  ): SatellitePickupData | null {
    const pickup = this.pickups.get(pickupId);
    if (pickup?.state !== 'loose' || pickup.health <= 0) {
      return null;
    }

    pickup.state = 'orbiting';
    pickup.ownerId = owner.id;
    pickup.orbitPhase = orbitPhase;
    pickup.orbitCenter = { ...owner.position };
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
      !pickup ||
      pickup.state === 'broken' ||
      pickup.health <= 0 ||
      !Number.isFinite(damage) ||
      damage <= 0
    ) {
      return null;
    }

    pickup.health = Math.max(0, pickup.health - damage);
    if (pickup.health <= 0) {
      pickup.state = 'broken';
      pickup.ownerId = null;
      pickup.respawnTimer = SATELLITE_PICKUP.RESPAWN_FRAMES;
      pickup.orbitCenter = { ...pickup.position };
      pickup.velocity = { x: 0, y: 0 };
    }
    return this.toPublic(pickup);
  }

  public countOrbitingFor(ownerId: string): number {
    let count = 0;
    for (const pickup of this.pickups.values()) {
      if (pickup.state === 'orbiting' && pickup.ownerId === ownerId) {
        count += 1;
      }
    }
    return count;
  }

  /** Place a second pickup opposite the owner's current orbiting pickup. */
  public nextOrbitPhaseFor(ownerId: string): number {
    const existing = Array.from(this.pickups.values())
      .filter((pickup) => pickup.state === 'orbiting' && pickup.ownerId === ownerId)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    return existing ? existing.orbitPhase + Math.PI : 0;
  }

  public releaseOwner(ownerId: string): void {
    for (const pickup of this.pickups.values()) {
      if (pickup.state === 'orbiting' && pickup.ownerId === ownerId) {
        this.makeLooseAtCurrentPose(pickup);
      }
    }
  }

  public update(owners: PickupOwnerPose[]): void {
    const byId = new Map(owners.map((owner) => [owner.id, owner]));
    for (const pickup of this.pickups.values()) {
      if (pickup.state === 'orbiting') {
        this.updateOrbiting(pickup, byId.get(pickup.ownerId ?? ''));
      } else if (pickup.state === 'broken') {
        this.updateBroken(pickup);
      } else if (!DEBUG.ENABLED || DEBUG.SATELLITE_PICKUP.MOVEMENT) {
        this.updateLoose(pickup);
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

    const prev = { ...pickup.position };
    pickup.orbitPhase += SATELLITE_PICKUP.ORBIT_SPEED;
    pickup.position = attachOrbitPosition(
      owner.position,
      pickup.orbitPhase,
      orbitRadiusForOwner(owner.radius, pickup.radius)
    );
    pickup.velocity = velocityFromDelta(prev, pickup.position);
    pickup.orbitCenter = { ...owner.position };
    pickup.angle = pickup.orbitPhase;
  }

  private updateBroken(pickup: SatellitePickupInternal): void {
    pickup.respawnTimer = Math.max(0, pickup.respawnTimer - 1);
    if (pickup.respawnTimer === 0) {
      this.respawnLoose(pickup);
    }
  }

  private updateLoose(pickup: SatellitePickupInternal): void {
    const prev = { ...pickup.position };
    const drifted = advanceDriftCenter(
      pickup.orbitCenter,
      pickup.driftAngle,
      SATELLITE_PICKUP.DRIFT_SPEED,
      SATELLITE_PICKUP.FIELD_RADIUS
    );
    pickup.orbitCenter = drifted.center;
    pickup.driftAngle = drifted.driftAngle;
    pickup.orbitPhase += SATELLITE_PICKUP.ORBIT_SPEED * 0.45;
    const offset = orbitOffset(pickup.orbitPhase, SATELLITE_PICKUP.LOOSE_ORBIT_RADIUS);
    pickup.position = clampToRadius(
      {
        x: pickup.orbitCenter.x + offset.x,
        y: pickup.orbitCenter.y + offset.y,
      },
      SATELLITE_PICKUP.FIELD_RADIUS
    );
    pickup.velocity = velocityFromDelta(prev, pickup.position);
    pickup.angle = pickup.orbitPhase;
  }

  private makeLooseAtCurrentPose(pickup: SatellitePickupInternal): void {
    pickup.state = 'loose';
    pickup.ownerId = null;
    pickup.orbitCenter = { ...pickup.position };
    pickup.velocity = { x: 0, y: 0 };
    pickup.respawnTimer = 0;
  }

  private respawnLoose(pickup: SatellitePickupInternal): void {
    const next = this.spawnLoose(
      pickup.rosterIndex,
      this.pickups.size,
      pickup.id,
      pickup.name,
      pickup.typeId
    );
    Object.assign(pickup, next);
  }

  private spawnLoose(
    index: number,
    count: number,
    id = `server-pickup-${randomUUID()}`,
    name = PICKUP_NAMES[index % PICKUP_NAMES.length] ?? 'Relay',
    typeId: SatellitePickupTypeId = index % 2 === 0 ? 'echo' : 'relay'
  ): SatellitePickupInternal {
    const orbitCenter = spawnRingPosition(index, count, () => this.rng.random());
    const orbitPhase = this.rng.random() * Math.PI * 2;
    const offset = orbitOffset(orbitPhase, SATELLITE_PICKUP.LOOSE_ORBIT_RADIUS);
    const position = clampToRadius(
      {
        x: orbitCenter.x + offset.x,
        y: orbitCenter.y + offset.y,
      },
      SATELLITE_PICKUP.FIELD_RADIUS
    );

    return {
      id,
      name,
      typeId,
      assetKey: `pickup/${typeId}`,
      position,
      velocity: { x: 0, y: 0 },
      angle: orbitPhase,
      radius: SATELLITE_PICKUP.SIZE / 2,
      color: PALETTE.SATELLITE_PICKUP,
      state: 'loose',
      ownerId: null,
      health: SATELLITE_PICKUP.HEALTH,
      maxHealth: SATELLITE_PICKUP.HEALTH,
      orbitCenter,
      orbitPhase,
      driftAngle: this.rng.random() * Math.PI * 2,
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
