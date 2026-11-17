import { CHARGED_WEAPON, chargedWeaponEnergy } from '../../shared/chargedWeapon';
import { GAME, LASER } from '../../shared/constants/gameplay';
import { hullRadiusForKit } from '../../shared/shipKits';
import type { Position, Velocity, WeaponChargeAction } from '../../shared-types';
import type { EntityManager, GameEntity } from './EntityManager';

interface ChargedProjectile {
  charged?: boolean;
  energy: number;
  miningDamage: number;
}

interface ChargedWeaponInputs<Shot extends ChargedProjectile> {
  actors: Pick<EntityManager, 'getEntity' | 'getAllEntities'>;
  frame: () => number;
  fire: (ownerId: string, start: Position, velocity: Velocity) => Shot | null;
}

/** Owns transient charge state; every release still passes ordinary shot admission. */
export class ChargedWeaponManager<Shot extends ChargedProjectile> {
  private charges = new WeakMap<GameEntity, number>();
  private cooldowns = new WeakMap<GameEntity, number>();

  constructor(private readonly inputs: ChargedWeaponInputs<Shot>) {}

  advance(frame: number): void {
    for (const pilot of this.inputs.actors.getAllEntities()) {
      const began = this.charges.get(pilot);
      if (
        began !== undefined &&
        (pilot.health <= 0 ||
          pilot.exploding ||
          pilot.overlayHold === true ||
          pilot.furnaceTransit ||
          frame - began > CHARGED_WEAPON.expiryFrames)
      ) {
        this.cancel(pilot);
      }
    }
  }

  request(ownerId: string, action: WeaponChargeAction): Shot | null {
    const pilot = this.inputs.actors.getEntity(ownerId);
    if (!pilot) {
      return null;
    }
    const frame = this.inputs.frame();
    const began = this.charges.get(pilot);
    if (action !== 'start') {
      this.cancel(pilot);
    }
    if (
      action === 'cancel' ||
      pilot.health <= 0 ||
      pilot.exploding ||
      pilot.overlayHold === true ||
      pilot.furnaceTransit
    ) {
      return null;
    }
    if (action === 'start') {
      if (began === undefined && frame >= (this.cooldowns.get(pilot) ?? 0)) {
        this.charges.set(pilot, frame);
      }
      return null;
    }
    if (began === undefined) {
      return null;
    }
    const frames = frame - began;
    if (frames < CHARGED_WEAPON.minimumFrames || frames > CHARGED_WEAPON.expiryFrames) {
      return null;
    }
    const reach = (4 / 3) * hullRadiusForKit(pilot.kitId);
    const dx = Math.cos(pilot.angle);
    const dy = -Math.sin(pilot.angle);
    const laser = this.inputs.fire(
      ownerId,
      { x: pilot.position.x + dx * reach, y: pilot.position.y + dy * reach },
      {
        x: pilot.velocity.x + (dx * LASER.SPEED) / GAME.FPS,
        y: pilot.velocity.y + (dy * LASER.SPEED) / GAME.FPS,
      }
    );
    if (laser) {
      laser.charged = true;
      laser.energy = chargedWeaponEnergy(frames);
      laser.miningDamage *= laser.energy;
      this.cooldowns.set(pilot, frame + CHARGED_WEAPON.cooldownFrames);
    }
    return laser;
  }

  isCharging(pilot: GameEntity): boolean {
    return this.charges.has(pilot);
  }

  chargeFrames(pilot: GameEntity, frame: number): number {
    const began = this.charges.get(pilot);
    return began === undefined ? 0 : Math.min(CHARGED_WEAPON.fullFrames, frame - began + 1);
  }

  cancel(pilot: GameEntity): void {
    this.charges.delete(pilot);
  }

  clear(): void {
    this.charges = new WeakMap();
    this.cooldowns = new WeakMap();
  }
}
