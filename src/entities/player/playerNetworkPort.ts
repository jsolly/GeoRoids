import type { PlayerUpdate } from '../../../shared-types';
import type { Player } from './Player';

interface PlayerNetworkPort {
  getAllPlayers(): Player[];
  setLocalPlayerName(name: string): void;
  updatePlayerState(playerState: Omit<PlayerUpdate, 'id'>): void;
}

let playerNetworkPort: PlayerNetworkPort | null = null;

export function bindPlayerNetworkPort(port: PlayerNetworkPort): void {
  playerNetworkPort = port;
}

export function resetPlayerNetworkPort(): void {
  playerNetworkPort = null;
}

export function requirePlayerNetworkPort(): PlayerNetworkPort {
  if (!playerNetworkPort) {
    throw new Error('Player network port is not bound');
  }
  return playerNetworkPort;
}
