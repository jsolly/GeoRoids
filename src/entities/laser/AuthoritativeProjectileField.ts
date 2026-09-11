import { v4 as uuidv4 } from 'uuid';
import type { PlayerProjectileState, PlayerShotAcknowledgement } from '../../../shared-types';
import { LASER } from '../../constants';
import type { Ship } from '../ship/Ship';
import { Laser } from './Laser';

interface PendingShot {
  ship: Ship;
  laser: Laser;
  expiresAt: number;
}

/** Server-keyed bolts plus bounded local predictions awaiting their shot receipt. */
export class AuthoritativeProjectileField {
  private static instance: AuthoritativeProjectileField;
  private rows: PlayerProjectileState[] = [];
  private enabled = false;
  private pending = new Map<string, PendingShot>();
  static getInstance(): AuthoritativeProjectileField {
    if (!AuthoritativeProjectileField.instance) {
      AuthoritativeProjectileField.instance = new AuthoritativeProjectileField();
    }
    return AuthoritativeProjectileField.instance;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  sync(projectiles: readonly PlayerProjectileState[]): void {
    this.enabled = true;
    this.rows = projectiles.map((row) => ({
      ...row,
      position: { ...row.position },
      prevPosition: { ...row.prevPosition },
      velocity: { ...row.velocity },
    }));
  }
  getProjectiles(): readonly PlayerProjectileState[] {
    return this.rows;
  }
  trackShot(ship: Ship, laser: Laser): string {
    this.expirePendingShots();
    const requestId = uuidv4();
    this.pending.set(requestId, {
      ship,
      laser,
      expiresAt: performance.now() + LASER.PREDICTION_TIMEOUT_MS,
    });
    return requestId;
  }

  acknowledgeShot(ack: PlayerShotAcknowledgement): void {
    this.expirePendingShots();
    const pending = this.pending.get(ack.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(ack.requestId);
    if (ack.projectileId === null) {
      this.removePrediction(pending);
    } else {
      pending.laser.serverId = ack.projectileId;
    }
  }

  private removePrediction({ ship, laser }: PendingShot): void {
    const index = ship.lasers.indexOf(laser);
    if (index !== -1) {
      ship.lasers.splice(index, 1);
    }
  }

  expirePendingShots(): void {
    if (this.pending.size === 0) {
      return;
    }
    const now = performance.now();
    for (const [id, pending] of this.pending) {
      if (now >= pending.expiresAt || !pending.ship.lasers.includes(pending.laser)) {
        this.removePrediction(pending);
        this.pending.delete(id);
      }
    }
  }

  reconcileShip(ship: Ship, ownerId: string): void {
    this.expirePendingShots();
    const previous = new Map(
      ship.lasers.filter((laser) => laser.serverId).map((laser) => [laser.serverId, laser])
    );
    ship.lasers = this.rows
      .filter((row) => row.ownerId === ownerId)
      .map((row) => {
        const laser =
          previous.get(row.id) ?? new Laser({ ...row.position }, { ...row.velocity }, 0, 0);
        laser.serverId = row.id;
        laser.abilityShot = row.abilityShot ?? false;
        laser.position = { ...row.position };
        laser.prevPosition = { ...row.prevPosition };
        laser.velocity = { ...row.velocity };
        laser.distTraveled = 0;
        laser.hasExploded = false;
        laser.explodeTime = 0;
        return laser;
      });
    for (const pending of this.pending.values()) {
      if (pending.ship === ship) {
        ship.lasers.push(pending.laser);
      }
    }
  }
  clear(): void {
    for (const pending of this.pending.values()) {
      this.removePrediction(pending);
    }
    this.pending.clear();
    this.rows = [];
    this.enabled = false;
  }
}
