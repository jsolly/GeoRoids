import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { UNATTRIBUTED_CLIENT } from './connectionAdmission';

/**
 * The canonical form of an IPv4-mapped address. Mapped is the one embedded-IPv4
 * family a dual-stack socket reports for an IPv4 peer, though it spells it
 * `::ffff:192.0.2.4`, which canonicalizes here. The anchors matter:
 * `1::ffff:192.0.2.4` canonicalizes to `1::ffff:c000:204`, which *contains*
 * those groups without being mapped, so an unanchored pattern would fold it
 * onto `192.0.2.4` and charge two hosts to one budget.
 *
 * IPv4-compatible and IPv4-translated forms name IPv4 hosts too, and are left
 * unfolded: no socket reports a peer that way, so none can split a budget.
 */
const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;

/**
 * One spelling per host, so a caller cannot hold several upgrade budgets at once.
 *
 * `isIP` is a format check, not a normalizer: it passes `192.0.2.4` and
 * `::ffff:192.0.2.4` for the same host, and `2001:db8::1` alongside its fully
 * written form for another. Each spelling would otherwise key its own bucket
 * and charge nothing to the rest. A zone index rides only an IPv6 address;
 * `isIP` rejects a dotted quad carrying one outright.
 *
 * The IPv6 canonical form is the URL host parser's, which is Node's own
 * implementation of the addressing spec's serializer; only the mapped fold is
 * ours, because that form names an IPv4 host rather than an IPv6 one.
 *
 * Aggregating further — to a /24 or /64 — was measured and rejected, as was
 * collapsing a link-local zone: see `docs/backlog-decisions.md`.
 *
 * Returns null for anything `isIP` does not accept, so a value that merely
 * looks like an address never becomes a key.
 */
export function normalizeClientAddress(value: string): string | null {
  const family = isIP(value);
  if (family === 4) {
    // `isIP` rejects leading zeros and accepts no zone here, so a dotted quad
    // it has passed is already canonical.
    return value;
  }
  if (family !== 6) {
    // Refuse before the URL parser below rather than letting it throw: a
    // spoofed header would otherwise cost an exception on every upgrade.
    return null;
  }
  // A link-local peer's zone is part of its identity, but such a peer cannot
  // reach this server across a network, so the collapse is deliberate; it is
  // recorded with the other residuals in `docs/backlog-decisions.md`.
  const bare = value.split('%')[0] ?? '';
  let canonical: string;
  try {
    canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    // Unreachable for anything `isIP` accepts as IPv6, and guarded regardless:
    // `verifyClient` wraps no handler of its own, so an escaping throw would
    // end the process and drop every pilot. `createServer` guards its other
    // `new URL` the same way.
    return null;
  }
  const mapped = IPV4_MAPPED.exec(canonical);
  if (!mapped) {
    return canonical;
  }
  const high = Number.parseInt(mapped[1] ?? '0', 16);
  const low = Number.parseInt(mapped[2] ?? '0', 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The address to charge a request to.
 *
 * Behind Railway's public HTTP ingress the socket's peer is the edge proxy, so
 * every caller looks like one address. Only that ingress supplies `X-Real-IP`;
 * a local proxy cannot select it, which is why the header is trusted only when
 * `railwayIngress` is true. Railway replaces a client-supplied value — verified
 * against the live ingress, see docs/agent-operations.md.
 *
 * Every charged address is resolved here, so normalizing in this function is
 * what gives both the upgrade budgets and the reporting listener's quotas one
 * key per host.
 *
 * Returns null rather than throwing or inventing a placeholder, so each caller
 * owns its own refusal policy: the reporting listener answers 503, while an
 * upgrade falls back to a shared bucket instead of locking pilots out.
 */
export function resolveClientAddress(req: IncomingMessage, railwayIngress: boolean): string | null {
  if (railwayIngress) {
    const value = req.headers['x-real-ip'];
    // Node joins duplicate headers into one comma-separated string, which
    // `isIP` rejects, so a caller appending its own header behind the edge
    // lands here rather than choosing its own bucket key.
    return typeof value === 'string' ? normalizeClientAddress(value) : null;
  }
  return normalizeClientAddress(req.socket.remoteAddress ?? '');
}

/**
 * The address a gameplay or log upgrade is charged to. Never null: an upgrade
 * the edge cannot attribute is charged to the shared `UNATTRIBUTED_CLIENT`
 * budget, which is fleet-sized in its own right, because refusing it outright
 * would lock pilots out for an ingress change.
 */
export function upgradeChargeAddress(req: IncomingMessage, railwayIngress: boolean): string {
  return resolveClientAddress(req, railwayIngress) ?? UNATTRIBUTED_CLIENT;
}
