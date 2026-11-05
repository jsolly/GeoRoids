import type { WeaponChargeAction } from '../../../shared-types';
import type { Laser } from '../laser/Laser';

export interface ShipCombatNetwork {
  readonly isConnected: boolean;
  sendShoot(laser: Laser): void;
  sendAbility(): boolean;
  sendShield?(): boolean;
  sendCharge(action: WeaponChargeAction): boolean;
}
