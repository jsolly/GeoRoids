import type { PlayerProjectileState, Position } from '../../../shared-types';
import { PALETTE } from '../../constants';
import type { Ship } from '../ship/Ship';
import { drawLaserBolts } from '../ship/shipRenderer';
import { Laser } from './Laser';

/** Complete keyed server projectile list. Events never append duplicate bolts. */
export class AuthoritativeProjectileField {
  private static instance: AuthoritativeProjectileField;
  private rows: PlayerProjectileState[] = [];
  private enabled = false;
  static getInstance(): AuthoritativeProjectileField {
    if (!AuthoritativeProjectileField.instance) {
      AuthoritativeProjectileField.instance = new AuthoritativeProjectileField();
    }
    return AuthoritativeProjectileField.instance;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  sync(projectiles: readonly PlayerProjectileState[], enabled: boolean): void {
    this.enabled = enabled;
    this.rows = enabled
      ? projectiles.map((row) => ({
          ...row,
          position: { ...row.position },
          prevPosition: { ...row.prevPosition },
          velocity: { ...row.velocity },
        }))
      : [];
  }
  getProjectiles(): readonly PlayerProjectileState[] {
    return this.rows;
  }
  reconcileShip(ship: Ship, ownerId: string): void {
    const previous = new Map(
      ship.lasers.filter((laser) => laser.serverId).map((laser) => [laser.serverId, laser])
    );
    ship.lasers = this.rows
      .filter((row) => row.ownerId === ownerId)
      .map((row) => {
        const laser =
          previous.get(row.id) ?? new Laser({ ...row.position }, { ...row.velocity }, 0, 0);
        laser.serverId = row.id;
        laser.position = { ...row.position };
        laser.prevPosition = { ...row.prevPosition };
        laser.velocity = { ...row.velocity };
        laser.distTraveled = 0;
        laser.hasExploded = false;
        laser.explodeTime = 0;
        return laser;
      });
  }
  clear(): void {
    this.rows = [];
    this.enabled = false;
  }
  draw(viewer: Position): void {
    const ordinary = this.rows
      .filter((row) => row.energy < 2)
      .map((row) => ({ ...row, explodeTime: 0 }));
    const charged = this.rows
      .filter((row) => row.energy >= 2)
      .map((row) => ({ ...row, explodeTime: 0 }));
    drawLaserBolts(ordinary, PALETTE.LASER_LOCAL, viewer);
    drawLaserBolts(charged, PALETTE.LASER_LOCAL, viewer);
  }
}
