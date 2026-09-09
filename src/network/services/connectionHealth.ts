/**
 * Heartbeat / staleness detection for the gameplay WebSocket.
 *
 * The browser does not always surface a half-open ("zombie") socket as closed:
 * the tab can believe it is still connected while the server has already torn
 * the player down (observed live as /health humanPlayers dropping 2 -> 1 while
 * both UIs kept "playing"). Because the server broadcasts game state ~30x/sec
 * to every connected human and answers our pings with a pong, a simple
 * client-side rule — "have we heard anything at all recently?" — reliably
 * detects a dead link without any server change.
 */

// Maximum time to establish a new gameplay socket.
export const CONNECTION_HANDSHAKE_TIMEOUT_MS = 10_000;

// Maximum time after a socket opens for the join acknowledgment and first
// authoritative state to arrive. Socket establishment alone is not a usable
// game session.
export const JOIN_COMPLETION_TIMEOUT_MS = 10_000;

// How often the client pings the server and checks liveness.
export const HEARTBEAT_INTERVAL_MS = 2000;

// If no message (game state, pong, anything) arrives within this window, the
// connection is considered dead. Generous relative to the ~33ms broadcast
// cadence so brief hitches never trip a false disconnect.
export const CONNECTION_STALE_TIMEOUT_MS = 6000;

/**
 * True when nothing has been received from the server for longer than
 * `timeoutMs`, indicating a broken/half-open connection.
 */
export function isConnectionStale(
  lastServerMessageAtMs: number,
  nowMs: number,
  timeoutMs: number = CONNECTION_STALE_TIMEOUT_MS
): boolean {
  return nowMs - lastServerMessageAtMs > timeoutMs;
}
