const WS_PATH_SUFFIX_PATTERN = /\/ws\/?$/u;
const TRAILING_SLASH_PATTERN = /\/$/u;

/**
 * Derive the client-log WebSocket from the gameplay URL so production
 * talks to Railway `/logs` instead of `www.georoids.com:3001/logs`.
 */
export function logsWebSocketUrlFromGameplay(
  gameplayUrl: string | undefined,
  pageHost: string,
  isSecure: boolean
): string {
  if (typeof gameplayUrl === 'string' && gameplayUrl.length > 0) {
    if (WS_PATH_SUFFIX_PATTERN.test(gameplayUrl)) {
      return gameplayUrl.replace(WS_PATH_SUFFIX_PATTERN, '/logs');
    }
    const trimmed = gameplayUrl.replace(TRAILING_SLASH_PATTERN, '');
    return `${trimmed}/logs`;
  }
  const protocol = isSecure ? 'wss' : 'ws';
  return `${protocol}://${pageHost}/logs`;
}
