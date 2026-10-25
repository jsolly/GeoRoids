/* @vitest-environment node */

import type { IncomingMessage } from 'node:http';
import { expect, test } from 'vitest';
import {
  clientNetwork,
  normalizeClientAddress,
  resolveClientAddress,
  resolveUpgradeAddress,
} from '../../../server/communication/clientAddress';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  GAMEPLAY_FLEET_RESERVE_PER_WINDOW,
  HONEST_LADDER_UPGRADES_PER_WINDOW,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
  LOG_FLEET_RESERVE_PER_WINDOW,
  MAX_PLAYERS,
} from '../../../server/communication/connectionAdmission';
import { RECONNECT_DELAYS_MS } from '../../../src/network/services/connectionReconnect';

/** What a network past the honest ladder may still draw from the gameplay lane. */
const GAMEPLAY_BEYOND_LADDER =
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL - GAMEPLAY_FLEET_RESERVE_PER_WINDOW;

function request(headers: Record<string, string>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

test('every pilot on a full server rejoins in one window instead of sharing one budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 2_000_000;

  // Before the fix the whole fleet arrived as Railway's edge proxy, so one
  // address spent the budget for all of them and a deploy locked most pilots out.
  // A full server climbing its whole retry ladder is the worst honest window.
  for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
    for (let attempt = 0; attempt < HONEST_LADDER_UPGRADES_PER_WINDOW; attempt += 1) {
      expect(admission.admit(`198.51.${pilot}.10`, '/ws', now).accepted).toBe(true);
    }
  }
  // Each still holds its own budget afterwards, so a retry ladder is not spent either.
  expect(admission.admit('198.51.0.10', '/ws', now + 500)).toMatchObject({
    accepted: true,
    count: HONEST_LADDER_UPGRADES_PER_WINDOW + 1,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
});

test('a pilot who has spent nothing still joins while one prefix floods the lane', () => {
  const admission = createConnectionAdmission(false);
  const now = 3_000_000;

  // A fresh address every attempt, all inside one IPv6 /64 — the block a
  // residential or cloud host is handed, so rotating the low bits is free.
  // Spend is charged to the prefix, so the rotation buys only its honest ladder
  // plus the lane's share for heavy callers.
  const admitted = HONEST_LADDER_UPGRADES_PER_WINDOW + GAMEPLAY_BEYOND_LADDER;
  for (let attempt = 0; attempt < admitted; attempt += 1) {
    expect(
      admission.admit(`2001:db8:dead:beef::${attempt.toString(16)}`, '/ws', now)
    ).toMatchObject({ accepted: true });
  }
  expect(admission.admit('2001:db8:dead:beef::ffff', '/ws', now + 1)).toMatchObject({
    accepted: false,
    lane: 'gameplay',
    firstRejection: true,
    refusedBy: 'reserve',
    network: '2001:0db8:dead:beef::/64',
    count: GAMEPLAY_BEYOND_LADDER,
    limit: GAMEPLAY_BEYOND_LADDER,
  });

  // The reserve is the whole point: a pilot from any other network, having spent
  // nothing this window, is still admitted rather than meeting a refusal it
  // cannot wait out. Its ladder runs about fifteen seconds and then its client
  // shows a banner that needs a manual reload.
  expect(admission.admit('203.0.113.5', '/ws', now + 1)).toMatchObject({
    accepted: true,
    refusedBy: null,
  });
  // The ceiling is a gameplay total: a diagnostic socket keeps its own.
  expect(admission.admit('2001:db8:dead:beef::ffff', '/logs', now + 1).accepted).toBe(true);
});

test('the lane ceiling still refuses an upgrade once honest networks have filled it', () => {
  const admission = createConnectionAdmission(false);
  const now = 4_000_000;

  // Every caller stays inside its honest ladder here, so nothing is held back
  // from the reserve and the absolute ceiling is what finally binds.
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; attempt += 1) {
    expect(
      admission.admit(`10.${Math.floor(attempt / 256)}.${attempt % 256}.7`, '/ws', now).accepted
    ).toBe(true);
  }
  expect(admission.admit('192.0.2.9', '/ws', now + 1)).toMatchObject({
    accepted: false,
    firstRejection: true,
    refusedBy: 'lane',
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
});

test('an upgrade a wider budget refused neither spends nor extends the caller window', () => {
  const admission = createConnectionAdmission(false);
  const start = 5_000_000;

  expect(admission.admit('192.0.2.7', '/ws', start).accepted).toBe(true);
  // Other networks take the gameplay lane to its ceiling in the same window.
  for (let attempt = 1; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; attempt += 1) {
    admission.admit(`10.${Math.floor(attempt / 256)}.${attempt % 256}.7`, '/ws', start);
  }
  expect(admission.admit('192.0.2.7', '/ws', start + 59_000)).toMatchObject({
    accepted: false,
    refusedBy: 'lane',
  });

  // That refusal left this caller's window anchored to its own last accepted
  // upgrade, so the window still rolls on time and the attempt cost it nothing.
  // Charging before reading the wider budgets would hold a retrying caller's
  // window open forever and bill them for upgrades they never got.
  expect(
    admission.admit('192.0.2.7', '/ws', start + CONNECTION_ADMISSION_WINDOW_MS + 1)
  ).toMatchObject({
    accepted: true,
    count: 1,
  });
});

test('pilots sharing one network reconnect at an honest rate before they share a budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 6_000_000;

  // Nothing in an upgrade separates a shared NAT from one host rotating
  // addresses, so a large shared network is squeezed once it is past the ladder.
  // Charging only past-ladder spend keeps the first pass open for all of them.
  for (let pilot = 0; pilot < 40; pilot += 1) {
    expect(admission.admit(`203.0.113.${pilot}`, '/ws', now).accepted).toBe(true);
  }
  // Their shared prefix is past the ladder now, so further retries draw on the
  // lane's heavy share rather than the fleet reserve.
  for (
    let attempt = 40;
    attempt < HONEST_LADDER_UPGRADES_PER_WINDOW + GAMEPLAY_BEYOND_LADDER;
    attempt += 1
  ) {
    expect(admission.admit(`203.0.113.${attempt % 40}`, '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit('203.0.113.1', '/ws', now)).toMatchObject({
    accepted: false,
    refusedBy: 'reserve',
    network: '203.0.113.0/24',
  });
});

test('the ceilings leave room for an honest fleet and keep logs tighter', () => {
  // A six-second stall retries on a 0.5/1/2/4/8 s ladder, so a full server can
  // legitimately spend five upgrades per pilot inside one window.
  expect(HONEST_LADDER_UPGRADES_PER_WINDOW).toBe(RECONNECT_DELAYS_MS.length);
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBeGreaterThanOrEqual(
    MAX_PLAYERS * HONEST_LADDER_UPGRADES_PER_WINDOW
  );
  // The reserve alone has to cover that fleet, or saturating the lane still
  // locks out pilots who have spent nothing.
  expect(GAMEPLAY_FLEET_RESERVE_PER_WINDOW).toBeGreaterThanOrEqual(
    MAX_PLAYERS * HONEST_LADDER_UPGRADES_PER_WINDOW
  );
  // And a share has to remain, or a caller past its ladder could never retry.
  expect(GAMEPLAY_BEYOND_LADDER).toBeGreaterThan(0);
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL).toBeLessThan(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL);
  expect(LOG_FLEET_RESERVE_PER_WINDOW).toBeLessThan(LOG_CONNECTIONS_PER_WINDOW_ALL);
});

test('one host cannot hold several upgrade budgets by respelling its address', () => {
  // `isIP` is a format check, not a normalizer, so each spelling of one host
  // used to key its own bucket and charge nothing to the others.
  expect(normalizeClientAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
  expect(normalizeClientAddress('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  expect(normalizeClientAddress('::ffff:0102:0304')).toBe('1.2.3.4');
  expect(normalizeClientAddress('fe80::1%eth0')).toBe(normalizeClientAddress('fe80::1'));
  expect(normalizeClientAddress('fe80::1%25eth0')).toBe(normalizeClientAddress('fe80::1'));
  expect(normalizeClientAddress('2001:db8::1')).toBe(
    normalizeClientAddress('2001:0db8:0000:0000:0000:0000:0000:0001')
  );
  // A value that only looks like an address never becomes a key.
  expect(normalizeClientAddress('1.2.3.04')).toBe(null);
  expect(normalizeClientAddress('not-an-address')).toBe(null);
  expect(normalizeClientAddress('')).toBe(null);
  expect(normalizeClientAddress('1:2:3:4:5:6:7:8:9')).toBe(null);
  expect(normalizeClientAddress('fe80::1::2')).toBe(null);

  expect(clientNetwork('1.2.3.4')).toBe('1.2.3.0/24');
  expect(clientNetwork(normalizeClientAddress('2001:db8:1:2:3:4:5:6') ?? '')).toBe(
    '2001:0db8:0001:0002::/64'
  );

  // The spellings share one budget in practice, not just in the helper.
  const admission = createConnectionAdmission(false);
  const now = 7_000_000;
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW; attempt += 1) {
    expect(admission.admit('1.2.3.4', '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit('::ffff:1.2.3.4', '/ws', now + 1)).toMatchObject({
    accepted: false,
    refusedBy: 'client',
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
});

test('the claimed forwarded address is trusted only behind Railway ingress', () => {
  const forwarded = request({ 'x-real-ip': '203.0.113.42' }, '172.16.0.1');
  expect(resolveClientAddress(forwarded, true)).toBe('203.0.113.42');
  // Without that ingress any caller could select the header, so the socket wins.
  expect(resolveClientAddress(forwarded, false)).toBe('172.16.0.1');

  // A value that is not an address is refused rather than used as a bucket key,
  // so a caller cannot mint budget by sending text that only looks like one.
  expect(resolveClientAddress(request({ 'x-real-ip': 'not-an-address' }, '172.16.0.1'), true)).toBe(
    null
  );
  expect(resolveClientAddress(request({}, '172.16.0.1'), true)).toBe(null);
  expect(resolveClientAddress(request({}), false)).toBe(null);

  // Either side of the ingress, one host resolves to one spelling.
  expect(resolveClientAddress(request({ 'x-real-ip': '::ffff:203.0.113.42' }), true)).toBe(
    '203.0.113.42'
  );
  expect(resolveClientAddress(request({}, '::ffff:172.16.0.1'), false)).toBe('172.16.0.1');

  // An upgrade is always charged to something: refusing one the server cannot
  // attribute would lock pilots out whenever ingress changed.
  expect(
    resolveUpgradeAddress(request({ 'x-real-ip': 'not-an-address' }, '172.16.0.1'), true)
  ).toBe('172.16.0.1');
  expect(resolveUpgradeAddress(request({}), true)).toBe('unknown');
});
