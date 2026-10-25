/* @vitest-environment node */

import type { IncomingMessage } from 'node:http';
import { expect, test } from 'vitest';
import {
  resolveClientAddress,
  upgradeChargeAddress,
} from '../../../server/communication/clientAddress';
import { clientNetwork, normalizeClientAddress } from '../../../server/communication/clientNetwork';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  GAMEPLAY_FLEET_RESERVE,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
  LOG_FLEET_RESERVE,
  MAX_PLAYERS,
  UNATTRIBUTED_CLIENT,
  WORST_HONEST_UPGRADES_PER_PILOT,
} from '../../../server/communication/connectionAdmission';
import { RECONNECT_DELAYS_MS } from '../../../src/network/services/connectionReconnect';

function request(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** What a network past the honest ladder may still draw from the gameplay lane. */
const GAMEPLAY_LADDER_SHARE = GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL - GAMEPLAY_FLEET_RESERVE;

/**
 * Spends the gameplay lane from fresh networks, each inside the honest ladder,
 * so the lane ceiling is what binds rather than the share for heavy callers.
 * Returns how many were refused, so a filler that stops working cannot pass.
 */
function spendLaneHonestly(
  admission: ReturnType<typeof createConnectionAdmission>,
  upgrades: number,
  at: number
) {
  const refused: string[] = [];
  for (let index = 0; index < upgrades; index += 1) {
    const network = Math.floor(index / WORST_HONEST_UPGRADES_PER_PILOT);
    const address = `10.${Math.floor(network / 256)}.${network % 256}.7`;
    if (!admission.admit(address, '/ws', at).accepted) {
      refused.push(address);
    }
  }
  return refused;
}

test('every pilot on a full server rejoins in one window instead of sharing one budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 2_000_000;

  // Before the fix the whole fleet arrived as Railway's edge proxy, so one
  // address spent the budget for all of them and a deploy locked most pilots out.
  for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
    expect(admission.admit(`198.51.100.${pilot}`, '/ws', now).accepted).toBe(true);
  }
  // Each still holds its own budget afterwards, so a retry ladder is not spent either.
  expect(admission.admit('198.51.100.0', '/ws', now + 500)).toMatchObject({
    accepted: true,
    count: 2,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
});

test('steady honest traffic never exhausts the lane, however long the server runs', () => {
  const admission = createConnectionAdmission(false);
  const start = 9_000_000;
  // The case whose absence hid a defect: every earlier case charged the lane at
  // a single instant, so none crossed a window boundary while traffic flowed.
  // Anchoring expiry to the last attempt made the lane bucket — charged by
  // every address — roll only after a server-wide lull, turning the ceiling
  // into a counter that climbed over uptime and then refused everyone.
  // Four hours at one upgrade per second is 14,400 upgrades against a ceiling
  // of 1,200, so a counter that does not roll cannot survive this.
  const spacingMs = 1_000;
  const upgrades = (4 * 3_600_000) / spacingMs;
  let refused = 0;
  for (let index = 0; index < upgrades; index += 1) {
    const at = start + index * spacingMs;
    if (index % 60 === 0) {
      admission.prune(at);
    }
    if (!admission.admit(`198.51.100.${index % MAX_PLAYERS}`, '/ws', at).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);
});

test('the gameplay lane refuses upgrades once honest networks have spent its total', () => {
  const admission = createConnectionAdmission(false);
  const now = 3_000_000;

  // Every caller here stays inside its honest ladder, so nothing is held back
  // from the reserve and the absolute ceiling is what finally binds. Claiming a
  // fresh address no longer reaches it: spend is charged to the prefix too, and
  // a single prefix is bounded well below the lane.
  expect(spendLaneHonestly(admission, GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL, now)).toEqual([]);
  expect(admission.admit('10.9.9.9', '/ws', now + 1)).toMatchObject({
    accepted: false,
    lane: 'gameplay',
    firstRejection: true,
    refusedBy: 'lane',
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
  // The ceiling is a gameplay total: a diagnostic socket keeps its own.
  expect(admission.admit('10.9.9.9', '/logs', now + 1).accepted).toBe(true);
});

test('a pilot who has spent nothing still joins while one prefix floods the lane', () => {
  const admission = createConnectionAdmission(false);
  const now = 7_000_000;

  // A fresh address every attempt, all inside one IPv6 /64 — the block a
  // residential or cloud host is handed, so rotating the low bits is free and
  // used to buy a fresh per-address budget every time. Spend is charged to the
  // prefix, so the rotation buys its honest ladder plus the lane's heavy share.
  const admitted = WORST_HONEST_UPGRADES_PER_PILOT + GAMEPLAY_LADDER_SHARE;
  for (let attempt = 0; attempt < admitted; attempt += 1) {
    expect(
      admission.admit(`2001:db8:dead:beef::${attempt.toString(16)}`, '/ws', now).accepted
    ).toBe(true);
  }
  expect(admission.admit('2001:db8:dead:beef::ffff', '/ws', now)).toMatchObject({
    accepted: false,
    firstRejection: true,
    refusedBy: 'reserve',
    network: '2001:0db8:dead:beef::/64',
    count: GAMEPLAY_LADDER_SHARE,
    limit: GAMEPLAY_LADDER_SHARE,
  });

  // The reserve is the point. Before it the ceiling was one counter, so a
  // flood that reached it refused every later upgrade in the window, including
  // from a network that had spent nothing — and a client gives up after its
  // ladder, so that refusal is a banner rather than a wait.
  expect(admission.admit('203.0.113.5', '/ws', now)).toMatchObject({
    accepted: true,
    refusedBy: null,
  });
});

test('an upgrade the lane ceiling refused neither spends nor extends the caller window', () => {
  const admission = createConnectionAdmission(false);
  const start = 4_000_000;

  // Give this caller a real prior spend, so rolling back to one is a contrast
  // rather than the only value it could have held.
  expect(admission.admit('192.0.2.7', '/ws', start).accepted).toBe(true);
  expect(admission.admit('192.0.2.7', '/ws', start + 10).accepted).toBe(true);
  expect(spendLaneHonestly(admission, GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL - 2, start + 20)).toEqual(
    []
  );
  expect(admission.admit('192.0.2.7', '/ws', start + 59_000)).toMatchObject({
    accepted: false,
    refusedBy: 'lane',
  });

  // That refusal left this caller's window anchored to its own first accepted
  // upgrade, so the window still rolls on time and the attempt cost it nothing.
  expect(
    admission.admit('192.0.2.7', '/ws', start + CONNECTION_ADMISSION_WINDOW_MS + 1)
  ).toMatchObject({ accepted: true, count: 1 });
});

test('a fleet the edge cannot attribute shares the lane rather than one address budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_000_000;

  // Ingress that stops supplying X-Real-IP used to charge every pilot to the
  // proxy's own address, which refused MAX_PLAYERS - 50 of them per window.
  // Unattributable traffic now answers to the lane ceiling instead.
  let refused = 0;
  for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
    if (!admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);
  expect(MAX_PLAYERS).toBeGreaterThan(GAMEPLAY_CONNECTIONS_PER_WINDOW);

  // The whole lane, not the share left to networks past the honest ladder.
  // Charging the ladder here would hand a lost header a second, tighter
  // ceiling, which is the same lockout in a smaller size: losing attribution
  // is not a caller's choice, and the edge replaces a client-supplied
  // X-Real-IP (verified; see docs/agent-operations.md), so this traffic is
  // never an attacker's doing.
  for (let spent = MAX_PLAYERS; spent < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; spent += 1) {
    expect(admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit(UNATTRIBUTED_CLIENT, '/ws', now)).toMatchObject({
    accepted: false,
    refusedBy: 'client',
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
});

test('the ceilings cover the fleet retry ladder the client actually uses', () => {
  // The ladder is the client's, so the server restates its length and this
  // pins the two against each other: the server may not import src/.
  expect(WORST_HONEST_UPGRADES_PER_PILOT).toBe(1 + RECONNECT_DELAYS_MS.length);

  // A fleet-wide stall costs one upgrade per pilot plus every retry. An earlier
  // revision counted only the retries, landing on a ceiling with no headroom at
  // all while its comment claimed headroom.
  const worstHonestFleetDemand = MAX_PLAYERS * (1 + RECONNECT_DELAYS_MS.length);
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBeGreaterThan(worstHonestFleetDemand);
  // A deploy or stall makes every pilot forward a record, so logs are
  // fleet-sized too, not a handful.
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL).toBeGreaterThanOrEqual(MAX_PLAYERS);

  // Both halves of the ceiling have to be fleet-sized for the split to help.
  // The reserve has to cover the fleet, or saturating the lane still refuses
  // pilots who have spent nothing; the remaining share has to cover it too, or
  // a fleet sharing one NAT is locked out once past the ladder, which is the
  // lockout moved rather than removed.
  expect(GAMEPLAY_FLEET_RESERVE).toBeGreaterThanOrEqual(worstHonestFleetDemand);
  expect(GAMEPLAY_LADDER_SHARE).toBeGreaterThanOrEqual(worstHonestFleetDemand);
  expect(LOG_FLEET_RESERVE).toBeGreaterThanOrEqual(MAX_PLAYERS);
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL - LOG_FLEET_RESERVE).toBeGreaterThanOrEqual(MAX_PLAYERS);
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
  expect(normalizeClientAddress('203.0.113.42, 9.9.9.9')).toBe(null);
  expect(normalizeClientAddress('not-an-address')).toBe(null);
  expect(normalizeClientAddress('')).toBe(null);
  expect(normalizeClientAddress('1:2:3:4:5:6:7:8:9')).toBe(null);
  expect(normalizeClientAddress('fe80::1::2')).toBe(null);

  expect(clientNetwork('1.2.3.4')).toBe('1.2.3.0/24');
  expect(clientNetwork(normalizeClientAddress('2001:db8:1:2:3:4:5:6') ?? '')).toBe(
    '2001:0db8:0001:0002::/64'
  );

  // The spellings share one budget in the limiter, not just in the helper.
  const admission = createConnectionAdmission(false);
  const now = 8_000_000;
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW; attempt += 1) {
    expect(admission.admit('1.2.3.4', '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit('::ffff:1.2.3.4', '/ws', now)).toMatchObject({
    accepted: false,
    refusedBy: 'client',
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
});

test('the whole honest fleet climbs its retry ladder inside one window', () => {
  const admission = createConnectionAdmission(false);
  const start = 6_000_000;

  // The scenario the ceiling is sized for, driven rather than asserted about:
  // every pilot drops, upgrades once, then retries on each ladder rung, all
  // inside a single window.
  let refused = 0;
  for (let rung = 0; rung <= RECONNECT_DELAYS_MS.length; rung += 1) {
    const at = start + RECONNECT_DELAYS_MS.slice(0, rung).reduce((sum, ms) => sum + ms, 0);
    for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
      if (!admission.admit(`198.51.100.${pilot}`, '/ws', at).accepted) {
        refused += 1;
      }
    }
  }
  expect(refused).toBe(0);
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
  // Node joins duplicate headers, which is the shape a caller appending its own
  // header behind the edge actually produces.
  expect(
    resolveClientAddress(request({ 'x-real-ip': '203.0.113.42, 9.9.9.9' }, '172.16.0.1'), true)
  ).toBe(null);
  expect(
    resolveClientAddress(request({ 'x-real-ip': ['203.0.113.42', '9.9.9.9'] }, '172.16.0.1'), true)
  ).toBe(null);
  expect(resolveClientAddress(request({}, '172.16.0.1'), true)).toBe(null);
  expect(resolveClientAddress(request({}), false)).toBe(null);

  // Either side of the ingress, one host resolves to one spelling.
  expect(resolveClientAddress(request({ 'x-real-ip': '::ffff:203.0.113.42' }), true)).toBe(
    '203.0.113.42'
  );
  expect(resolveClientAddress(request({}, '::ffff:172.16.0.1'), false)).toBe('172.16.0.1');
});

test('the address an upgrade is charged to never falls back to the proxy peer', () => {
  // The composition is the actual fix, so it is covered directly: the limiter
  // itself is disabled under VITEST, which left this unreachable before.
  expect(upgradeChargeAddress(request({ 'x-real-ip': '203.0.113.42' }, '172.16.0.1'), true)).toBe(
    '203.0.113.42'
  );
  // Behind ingress without a usable header the peer is the edge proxy, so
  // charging it would put the fleet in one bucket. Charge the shared budget.
  expect(upgradeChargeAddress(request({}, '172.16.0.1'), true)).toBe(UNATTRIBUTED_CLIENT);
  expect(upgradeChargeAddress(request({ 'x-real-ip': 'nope' }, '172.16.0.1'), true)).toBe(
    UNATTRIBUTED_CLIENT
  );
  // Without ingress the socket peer is the client and is charged as before.
  expect(upgradeChargeAddress(request({}, '172.16.0.1'), false)).toBe('172.16.0.1');
  expect(upgradeChargeAddress(request({}), false)).toBe(UNATTRIBUTED_CLIENT);
});
