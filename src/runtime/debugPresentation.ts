import { debugIsOn, LOCAL_STORAGE_KEYS } from '../constants/user-preferences';
import { GameController } from '../core/gameController';
import { buildClientDiagnostics } from '../diagnostics/clientDiagnostics';
import { readDebugHudMetrics } from '../diagnostics/debugHudMetrics';
import {
  formatDebugFps,
  formatDebugMotion,
  formatDebugReleases,
  formatDebugRtt,
  formatDebugSnapshot,
  formatDebugWorld,
} from '../ui/debugHud';
import { getClientReleaseId } from '../utils/buildInfo';
import { getClientLogContext } from '../utils/clientLogContext';
import { logger } from '../utils/Logger';
import { getStoredItem, setStoredItem } from '../utils/safeStorage';

export interface DebugView {
  readonly playerId: string;
  readonly sessionId: string;
  readonly hudHidden: boolean;
  readonly fps: string;
  readonly rtt: string;
  readonly snapshot: string;
  readonly motion: string;
  readonly world: string;
  readonly releases: string;
}

/** Diagnostics are scalar snapshots. Detailed dumps are built only on Copy. */
export function createDebugPresentation(changed: () => void) {
  const enabled = debugIsOn();
  const lifetime = new AbortController();
  let disposed = false;
  let playerId = '';
  let hidden = getStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden) === 'true';
  let nextSampleAt = 0;
  let metrics = { fps: '—', rtt: '—', snapshot: '—', motion: '—', world: '—', releases: '—' };
  logger.applyConfiguredLogLevel();
  window.addEventListener(
    'playerIdentityChanged',
    (event) => {
      const id: unknown = event.detail?.playerId;
      if (typeof id === 'string' && id && id !== playerId) {
        playerId = id.slice(0, 128);
        changed();
      }
    },
    { signal: lifetime.signal }
  );
  return {
    read(inPlay: boolean, now = performance.now()): DebugView | null {
      if (!enabled || disposed) {
        return null;
      }
      if (inPlay && !hidden && now >= nextSampleAt) {
        nextSampleAt = now + 250;
        const current = readDebugHudMetrics(now);
        const game = GameController.getInstance();
        metrics = {
          fps: formatDebugFps(current.fps),
          rtt: formatDebugRtt(current.rttMs),
          snapshot: formatDebugSnapshot(current.snapshotSequence, current.snapshotAgeMs),
          motion: formatDebugMotion(game.getCurrPlayer()?.ship.playerMotion),
          world: formatDebugWorld(
            game.getNetworkManager().getAllPlayers().length,
            game.getCurrRoidCount(),
            game.getLoot().length
          ),
          releases: formatDebugReleases(
            getClientReleaseId(),
            game.getNetworkManager().getServerReleaseId()
          ),
        };
      }
      return Object.freeze({
        playerId,
        sessionId: getClientLogContext().sessionId,
        hudHidden: hidden,
        ...metrics,
      });
    },
    toggleHud(): void {
      if (!enabled || disposed) {
        return;
      }
      hidden = !hidden;
      nextSampleAt = 0;
      setStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden, String(hidden));
      changed();
    },
    diagnostics(): string {
      return enabled && !disposed ? buildClientDiagnostics() : '';
    },
    dispose(): void {
      disposed = true;
      lifetime.abort();
      playerId = '';
    },
  };
}
