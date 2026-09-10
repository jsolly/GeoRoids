import type { Player } from './Player';

/**
 * Advance remote human ships on the shared 60 Hz lifecycle clock.
 *
 * Pose stays server-driven (`updateLifecycle` does not predict movement).
 * Explode / blink must still tick or remotes freeze at the first death frame
 * and stay laser-immune after respawn. Lasers share that simulation step.
 */
export function advanceRemotePlayerShips(players: Player[]): void {
  for (const player of players) {
    if (player.type === 'remote') {
      player.ship.updateLifecycle();
      if (!player.ship.exploding && player.ship.health > 0) {
        player.ship.moveLasers();
      }
    }
  }
}
