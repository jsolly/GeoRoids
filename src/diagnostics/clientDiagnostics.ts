import { readAudioDiagnostics } from '../audio/audioRuntime';
import { readMusicDiagnostics } from '../audio/musicBeds';
import { GameController } from '../core/gameController';
import { readTouchControlDiagnostics } from '../input/touchControls';
import { getClientReleaseId } from '../utils/buildInfo';
import { getClientLogContext } from '../utils/clientLogContext';
import { logger } from '../utils/Logger';
import { readDebugHudMetrics } from './debugHudMetrics';

/** Explicit fields only: never serialize the player, transport or browser storage. */
export function buildClientDiagnostics(): string {
  const game = GameController.getInstance();
  const network = game.getNetworkManager();
  const player = game.getCurrPlayer();
  const ship = player?.ship;
  const state = {
    version: 1,
    capturedAt: new Date().toISOString(),
    ...getClientLogContext(),
    clientReleaseId: getClientReleaseId(),
    serverReleaseId: network.getServerReleaseId(),
    browser: navigator.userAgent,
    page: {
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      width: innerWidth,
      height: innerHeight,
    },
    audio: { ...readAudioDiagnostics(), ...readMusicDiagnostics() },
    metrics: readDebugHudMetrics(performance.now()),
    connected: network.isConnected,
    running: game.getIsGameRunning(),
    ship: ship
      ? {
          id: player?.id,
          kitId: ship.kitId,
          position: ship.position,
          velocity: ship.velocity,
          health: ship.health,
          lives: player?.lives,
          exploding: ship.exploding,
          thrusting: ship.thrusting,
          movementLocked: ship.movementLocked,
          serverOwnsMotion: ship.serverOwnsMotion,
          motion: ship.playerMotion,
          boost: ship.boost,
        }
      : null,
    input: readTouchControlDiagnostics(),
    world: {
      players: network.getAllPlayers().length,
      asteroids: game.getCurrRoidCount(),
      loot: game.getLoot().length,
    },
  };
  return `GeoRoids diagnostics\n${JSON.stringify(state, null, 2)}\nRecent client logs (up to 80, oldest first):\n${logger.getRecentDiagnostics().join('\n')}`;
}
