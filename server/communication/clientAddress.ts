import type { IncomingMessage } from 'node:http';
import { normalizeClientAddress } from './clientNetwork';
import { UNATTRIBUTED_CLIENT } from './connectionAdmission';

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
    // Node joins duplicate headers into one comma-separated string, which is
    // not an address, so a caller appending its own header behind the edge
    // lands here rather than choosing its own bucket key. Normalizing gives one
    // spelling per host, so no caller holds several budgets; see clientNetwork.
    return typeof value === 'string' ? normalizeClientAddress(value) : null;
  }
  return normalizeClientAddress(req.socket.remoteAddress ?? '');
}

/**
 * The address a gameplay or log upgrade is charged to. Never null: an upgrade
 * the edge cannot attribute is charged to the shared `UNATTRIBUTED_CLIENT`
 * budget, which the lane ceiling bounds, because refusing it outright would
 * lock pilots out for an ingress change.
 */
export function upgradeChargeAddress(req: IncomingMessage, railwayIngress: boolean): string {
  return resolveClientAddress(req, railwayIngress) ?? UNATTRIBUTED_CLIENT;
}
