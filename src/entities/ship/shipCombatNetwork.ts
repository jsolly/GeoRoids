import type { ShipKitId } from '../../../shared-types';
import type { Laser } from '../laser/Laser';

export interface ShipCombatNetwork {
  readonly isConnected: boolean;
  sendShoot(laser: Laser): void;
  sendAbility(data: { kitId: ShipKitId; abilityId: string }): boolean;
}
