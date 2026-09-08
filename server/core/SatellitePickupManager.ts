import { randomUUID } from 'node:crypto';
import { logger } from '../../setup/serverLogger';
import type { Position, SatellitePickupData, SatellitePickupTypeId } from '../../shared-types';
import { DEBUG, PALETTE, SATELLITE_PICKUP } from '../../src/constants';
import {
  advanceDriftCenter,
  attachOrbitPosition,
  clampToRadius,
  orbitOffset,
  spawnRingPosition,
  velocityFromDelta,
} from '../../src/entities/satellitePickup/satellitePickupMath';
import type { RNGService } from './RNGService';

const PICKUP_NAMES = ['Echo', 'Relay'] as const;

export interface PickupOwnerPose {
  id: string;
  position: Position;
  health: number;
  exploding: boolean;
}

interface SatellitePickupInternal extends SatellitePickupData {
  rosterIndex: number;
  orbitCenter: Position;
  orbitPhase: number;
  driftAngle: number;
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

  public collect(
    pickupId: string,
    ownerId: string,
    orbitingAlready: number
  ): SatellitePickupData | null {
    const pickup = this.pickups.get(pickupId);
    if (pickup?.state !== 'loose') {
      return null;
    }

    pickup.state = 'orbiting';
    pickup.ownerId = ownerId;
    pickup.shieldFramesRemaining = SATELLITE_PICKUP.SHIELD_FRAMES;
    pickup.orbitPhase = orbitingAlready * Math.PI;
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
      SATELLITE_PICKUP.ORBIT_RADIUS
    );
    pickup.velocity = velocityFromDelta(prev, pickup.position);
    pickup.angle = pickup.orbitPhase;
    pickup.shieldFramesRemaining -= 1;

    if (pickup.shieldFramesRemaining <= 0) {
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
    pickup.shieldFramesRemaining = 0;
    pickup.orbitCenter = { ...pickup.position };
    pickup.velocity = { x: 0, y: 0 };
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
      shieldFramesRemaining: 0,
      orbitCenter,
      orbitPhase,
      driftAngle: this.rng.random() * Math.PI * 2,
      rosterIndex: index,
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
      shieldFramesRemaining: pickup.shieldFramesRemaining,
    };
  }
}
