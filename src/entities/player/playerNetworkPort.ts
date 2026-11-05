import type { PlayerUpdate } from '../../../shared-types';
import type { Player } from './Player';

export interface PlayerNetworkPort {
  getAllPlayers(): Player[];
  setLocalPlayerName(name: string): void;
  /** False when the pose was not sent, so a caller can retry on the next frame. */
  updatePlayerState(playerState: Omit<PlayerUpdate, 'id'>): boolean;
}
