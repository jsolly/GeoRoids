let listenerScope: AbortController | null = null;

import { playFeedback } from '../audio/feedbackSounds';
import { logger } from '../utils/Logger';

/**
 * Visible network-status banner.
 *
 * Previously a dropped WebSocket only produced a log line: the game kept
 * rendering the last-known snapshot with no indication that the connection was
 * gone. This surfaces a clear banner when the socket drops (and hides it again
 * on (re)connect) so players know when they've been disconnected.
 */

export interface NetworkStatusView {
  readonly message: string;
  readonly tone: 'error' | 'reconnect';
}
let initialized = false;
let lossAnnounced = false;
let current: NetworkStatusView | null = null;
const subscribers = new Set<() => void>();

export function readNetworkStatus(): NetworkStatusView | null {
  return current;
}

export function subscribeNetworkStatus(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function publish(next: NetworkStatusView | null): void {
  if (current?.message === next?.message && current?.tone === next?.tone) {
    return;
  }
  current = next ? Object.freeze(next) : null;
  for (const listener of subscribers) {
    listener();
  }
}

export const DISCONNECT_BANNER_TEXT =
  'Disconnected from game server. Select Enter Game to try again.';
export const RECONNECTING_BANNER_TEXT = 'Reconnecting to game server…';

export function showNetworkBanner(message: string, tone: 'error' | 'reconnect' = 'error'): void {
  publish({ message: message.slice(0, 500), tone });
}

export function hideNetworkBanner(): void {
  lossAnnounced = false;
  publish(null);
}

/**
 * Wire the banner to the network lifecycle events dispatched by
 * ConnectionManager. Idempotent — safe to call more than once.
 */
export function mountNetworkStatus(): () => void {
  if (initialized || typeof window === 'undefined') {
    return () => {};
  }
  const scope = new AbortController();
  listenerScope = scope;
  const { signal } = scope;
  initialized = true;

  window.addEventListener('networkConnected', () => hideNetworkBanner(), { signal });
  window.addEventListener('networkReconnected', () => hideNetworkBanner(), { signal });
  window.addEventListener(
    'networkReconnecting',
    () => {
      showNetworkBanner(RECONNECTING_BANNER_TEXT, 'reconnect');
    },
    { signal }
  );
  window.addEventListener(
    'networkDisconnected',
    (event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      showNetworkBanner(DISCONNECT_BANNER_TEXT);
      logger.warn('NETWORK', 'Displayed disconnect banner', { reason });
    },
    { signal }
  );
  window.addEventListener(
    'networkPermanentlyDisconnected',
    (event) => {
      if (!lossAnnounced) {
        playFeedback('connectionLost');
        lossAnnounced = true;
      }
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
      showNetworkBanner(DISCONNECT_BANNER_TEXT);
      logger.warn('NETWORK', 'Displayed permanent disconnect banner', { reason });
    },
    { signal }
  );
  return () => {
    if (listenerScope !== scope) {
      return;
    }
    scope.abort();
    listenerScope = null;
    initialized = false;
    hideNetworkBanner();
  };
}
