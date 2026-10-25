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
 * for another, and a `%eth0` zone suffix on top of either. Each of those
 * spellings would otherwise key its own bucket and charge nothing to the rest.
 *
 * Returns null for anything that is not an address, so a value that merely
 * looks like one never becomes a key.
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
 * it nothing and buys a fresh budget every time; /24 is the IPv4 equivalent at
 * a far higher price. Charging the prefix as well makes that rotation finite.
 *
 * Nothing in an upgrade separates pilots genuinely sharing a prefix — an ISP
 * block, a campus range, a cloud subnet — from one host rotating addresses
 * inside it, so they share this budget. `connectionAdmission` charges a network
 * only for spend past an honest retry ladder, and sizes that share for a whole
 * fleet, so a fleet spread across one prefix still rejoins.
 *
 * This bounds a prefix, not a single address. A fleet behind one NAT reaches
 * the edge as one address, where the per-address budget bounds it: that budget
 * is read first and nothing here changes it.
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
