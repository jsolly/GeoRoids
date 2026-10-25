import type { IncomingMessage } from 'node:http';
import { isIP, isIPv4 } from 'node:net';

/** IPv4-mapped IPv6 addresses carry the v4 address in the last two groups. */
const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff] as const;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/iu;
const IPV4_OCTETS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Expands one side of a `::` into 16-bit groups, taking a dotted v4 tail as two. */
function expandGroups(part: string): number[] | null {
  if (part === '') {
    return [];
  }
  const pieces = part.split(':');
  const groups: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    const octets = index === pieces.length - 1 ? IPV4_OCTETS.exec(piece) : null;
    if (octets) {
      // The pattern fixes four octets, so the defaults are unreachable.
      const [first = 0, second = 0, third = 0, fourth = 0] = octets.slice(1).map(Number);
      if (first > 255 || second > 255 || third > 255 || fourth > 255) {
        return null;
      }
      groups.push((first << 8) | second, (third << 8) | fourth);
      continue;
    }
    if (!IPV6_GROUP.test(piece)) {
      return null;
    }
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function parseIPv6(value: string): number[] | null {
  const halves = value.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = expandGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? expandGroups(halves[1] ?? '') : [];
  if (!head || !tail) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const elided = 8 - head.length - tail.length;
  // `::` stands for at least one group, so a full eight either side is malformed.
  return elided < 1 ? null : [...head, ...Array<number>(elided).fill(0), ...tail];
}

/**
 * One spelling per host, so a caller cannot hold several budgets at once.
 *
 * `isIP` is a format check, not a normalizer: it passes `1.2.3.4` and
 * `::ffff:1.2.3.4` for the same host, `2001:db8::1` and its fully written form
 * for another, and a `%eth0` zone suffix on top of either. Each of those spellings
 * would otherwise key its own bucket and charge nothing to the others.
 *
 * Returns null for anything that is not an address, so a value that merely looks
 * like one never becomes a key.
 */
export function normalizeClientAddress(value: string): string | null {
  // A zone index names a local interface, not a different host.
  const bare = value.split('%')[0] ?? '';
  if (isIPv4(bare)) {
    // `isIPv4` rejects leading zeros, so a dotted quad is already canonical.
    return bare;
  }
  const groups = isIP(bare) === 6 ? parseIPv6(bare) : null;
  if (!groups) {
    return null;
  }
  if (IPV4_MAPPED_PREFIX.every((group, index) => groups[index] === group)) {
    const [high = 0, low = 0] = groups.slice(6);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return groups.map((group) => group.toString(16).padStart(4, '0')).join(':');
}

/**
 * The network a normalized address sits in: an IPv4 /24 or an IPv6 /64.
 *
 * A per-address budget alone bounds nobody who holds a prefix. A residential or
 * cloud IPv6 host is normally given a whole /64, so rotating the low bits costs
 * it nothing and buys a fresh budget every time; /24 is the IPv4 equivalent at a
 * far higher price. Charging the prefix as well makes that rotation finite.
 *
 * The cost is real and deliberate: pilots genuinely sharing one NAT or campus
 * network share a budget, because nothing in an upgrade distinguishes them from
 * one host rotating addresses. `connectionAdmission` charges the network only
 * for spend past an honest retry ladder, so a shared network reconnecting at a
 * normal rate is never the one refused.
 */
export function clientNetwork(address: string): string {
  if (isIPv4(address)) {
    const [first, second, third] = address.split('.');
    return `${first}.${second}.${third}.0/24`;
  }
  const groups = address.split(':');
  // Anything else reached here unnormalized; charge it alone rather than
  // widening a bucket an unexpected value would share.
  return groups.length === 8 ? `${groups.slice(0, 4).join(':')}::/64` : address;
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
 * Returns null rather than throwing or inventing a placeholder, so each caller
 * owns its own refusal policy: the reporting listener answers 503, while an
 * upgrade falls back to a shared bucket instead of locking pilots out.
 */
export function resolveClientAddress(req: IncomingMessage, railwayIngress: boolean): string | null {
  if (railwayIngress) {
    const value = req.headers['x-real-ip'];
    return typeof value === 'string' ? normalizeClientAddress(value) : null;
  }
  return normalizeClientAddress(req.socket.remoteAddress ?? '');
}

/**
 * The address an upgrade is charged to. Never null: refusing an upgrade the
 * server cannot attribute would lock pilots out on an ingress change, so an
 * unattributable one shares a single coarse bucket that the wider budgets bound.
 *
 * Behind the ingress a missing or unusable `X-Real-IP` falls back to the socket
 * peer, which is the edge proxy, so those callers share one budget until the
 * header returns.
 */
export function resolveUpgradeAddress(req: IncomingMessage, railwayIngress: boolean): string {
  return (
    resolveClientAddress(req, railwayIngress) ??
    normalizeClientAddress(req.socket.remoteAddress ?? '') ??
    'unknown'
  );
}
