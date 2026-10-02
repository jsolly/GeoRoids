import type { PlayerUpdate } from '../../../shared-types';
import type { Player } from './Player';

export interface PlayerNetworkPort {
  getAllPlayers(): Player[];
  setLocalPlayerName(name: string): void;
  updatePlayerState(playerState: Omit<PlayerUpdate, 'id'>): void;
}
