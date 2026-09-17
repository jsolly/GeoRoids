import type { HaulerUtilityId } from '../../../shared-types';

interface HaulerUtilityNetwork {
  send(utilityId: HaulerUtilityId, playerId: string): void;
}

let haulerUtilityNetwork: HaulerUtilityNetwork | null = null;

export function bindHaulerUtilityNetwork(network: HaulerUtilityNetwork): void {
  haulerUtilityNetwork = network;
}

export function sendHaulerUtility(utilityId: HaulerUtilityId, playerId: string): void {
  haulerUtilityNetwork?.send(utilityId, playerId);
}
