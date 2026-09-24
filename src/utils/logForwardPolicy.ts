const PRODUCTION_STATE_INFO = new Set(['player_died', 'player_respawned']);

/**
 * Production forwards warnings, errors, and rare death or respawn transitions.
 * Reconnect and snapshot info stay in the browser. Development also forwards
 * other STATE info. Debug and forwarder self-logs never open a socket.
 */
export function shouldForwardClientLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  category: string,
  production: boolean,
  message = ''
): boolean {
  if (category === 'LOG_FORWARD') {
    return false;
  }
  if (level === 'warn' || level === 'error') {
    return true;
  }
  if (level !== 'info' || category !== 'STATE') {
    return false;
  }
  if (!production) {
    return true;
  }
  return PRODUCTION_STATE_INFO.has(message);
}
