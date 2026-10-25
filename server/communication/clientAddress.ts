import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/**
 * The address to charge a request to.
 *
 * Behind Railway's public HTTP ingress the socket's peer is the edge proxy, so
 * every caller looks like one address. Only that ingress supplies `X-Real-IP`;
 * a local proxy cannot select it, which is why the header is trusted only when
 * `railwayIngress` is true.
 *
 * Returns null rather than throwing or inventing a placeholder, so each caller
 * owns its own refusal policy: the reporting listener answers 503, while an
 * upgrade falls back to a shared bucket instead of locking pilots out.
 */
export function resolveClientAddress(req: IncomingMessage, railwayIngress: boolean): string | null {
  if (railwayIngress) {
    const value = req.headers['x-real-ip'];
    return typeof value === 'string' && isIP(value) ? value : null;
  }
  return req.socket.remoteAddress ?? null;
}
