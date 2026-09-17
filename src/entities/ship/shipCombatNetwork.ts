import type { ShipKitId } from '../../../shared-types';
import type { Laser } from '../laser/Laser';

interface ShipCombatNetwork {
  readonly isConnected: boolean;
  readonly localPlayerId: string;
  sendShoot(laser: Laser): void;
  sendAbility(data: { kitId: ShipKitId; abilityId: string }): boolean;
}

let shipCombatNetwork: ShipCombatNetwork | null = null;

export function bindShipCombatNetwork(network: ShipCombatNetwork): void {
  shipCombatNetwork = network;
}

export function getShipCombatNetwork(): ShipCombatNetwork | null {
  return shipCombatNetwork;
}

export function resetShipCombatNetwork(): void {
  shipCombatNetwork = null;
}
