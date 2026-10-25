/* @vitest-environment node */

import type { IncomingMessage } from 'node:http';
import { expect, test } from 'vitest';
import {
  resolveClientAddress,
  upgradeChargeAddress,
} from '../../../server/communication/clientAddress';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
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

test('the gameplay lane refuses upgrades once its total is spent, whatever address they claim', () => {
  const admission = createConnectionAdmission(false);
  const now = 3_000_000;

  // A fresh address every time, so no per-address bucket is ever reached.
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; attempt += 1) {
    expect(
      admission.admit(`10.1.${Math.floor(attempt / 256)}.${attempt % 256}`, '/ws', now).accepted
    ).toBe(true);
  }
  const refused = admission.admit('10.9.9.9', '/ws', now + 1);
  expect(refused).toMatchObject({
    accepted: false,
    lane: 'gameplay',
    firstRejection: true,
    laneExhausted: true,
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
  // The ceiling is a gameplay total: a diagnostic socket keeps its own.
  expect(admission.admit('10.9.9.9', '/logs', now + 1).accepted).toBe(true);
});

test('an upgrade the lane ceiling refused neither spends nor extends the caller window', () => {
  const admission = createConnectionAdmission(false);
  const start = 4_000_000;

  // Give this caller a real prior spend, so rolling back to one is a contrast
  // rather than the only value it could have held.
  expect(admission.admit('192.0.2.7', '/ws', start).accepted).toBe(true);
  expect(admission.admit('192.0.2.7', '/ws', start + 10).accepted).toBe(true);
  for (let attempt = 2; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; attempt += 1) {
    admission.admit(`10.2.${Math.floor(attempt / 256)}.${attempt % 256}`, '/ws', start + 20);
  }
  expect(admission.admit('192.0.2.7', '/ws', start + 59_000)).toMatchObject({
    accepted: false,
    laneExhausted: true,
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
