import { logger } from '../utils/Logger';

/**
 * Visible network-status banner.
 *
 * Previously a dropped WebSocket only produced a log line: the game kept
 * rendering the last-known snapshot with no indication that the connection was
 * gone. This surfaces a clear banner when the socket drops (and hides it again
 * on (re)connect) so players know when they've been disconnected.
 */

const BANNER_ID = 'network-status-banner';
let initialized = false;

function getOrCreateBanner(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'alert');
    Object.assign(el.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '10000',
      padding: 'calc(10px + env(safe-area-inset-top, 0px)) 16px 10px',
      textAlign: 'center',
      background: 'rgba(180, 0, 0, 0.92)',
      color: '#ffffff',
      font: '600 15px/1.4 Arial, sans-serif',
      letterSpacing: '0.3px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
      display: 'none',
    });
    (document.body ?? document.documentElement).appendChild(el);
  }
  return el;
}

export const DISCONNECT_BANNER_TEXT =
  'Disconnected from game server. Select Enter Game to try again.';
export const RECONNECTING_BANNER_TEXT = 'Reconnecting to game server…';

export function showNetworkBanner(message: string, tone: 'error' | 'reconnect' = 'error'): void {
  const el = getOrCreateBanner();
  if (!el) {
    return;
  }
  el.textContent = message;
  el.style.background = tone === 'reconnect' ? 'rgba(180, 110, 0, 0.92)' : 'rgba(180, 0, 0, 0.92)';
  el.style.display = 'block';
}

export function hideNetworkBanner(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const el = document.getElementById(BANNER_ID);
  if (el) {
    el.style.display = 'none';
  }
}

export function isNetworkBannerVisible(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const el = document.getElementById(BANNER_ID);
  return el !== null && el.style.display !== 'none';
}

/**
 * Wire the banner to the network lifecycle events dispatched by
 * ConnectionManager. Idempotent — safe to call more than once.
 */
export function initNetworkStatusUI(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }
  initialized = true;

  window.addEventListener('networkConnected', () => hideNetworkBanner());
  window.addEventListener('networkReconnected', () => hideNetworkBanner());
  window.addEventListener('networkReconnecting', () => {
    showNetworkBanner(RECONNECTING_BANNER_TEXT, 'reconnect');
  });
  window.addEventListener('networkDisconnected', (event) => {
    const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
    showNetworkBanner(DISCONNECT_BANNER_TEXT);
    logger.warn('NETWORK', 'Displayed disconnect banner', { reason });
  });
  window.addEventListener('networkPermanentlyDisconnected', (event) => {
    const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason;
    showNetworkBanner(DISCONNECT_BANNER_TEXT);
    logger.warn('NETWORK', 'Displayed permanent disconnect banner', { reason });
  });
}
