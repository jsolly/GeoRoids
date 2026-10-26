/* @vitest-environment node */

import { readFileSync } from 'node:fs';
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
  LOG_CONNECTIONS_PER_WINDOW,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
  MAX_PLAYERS,
  MAX_TRACKED_ADDRESSES,
  UNATTRIBUTED_CLIENT,
  UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW,
  UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW,
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

test('one address keeps its per-window budget however long it keeps calling', () => {
  const admission = createConnectionAdmission(false);
  const start = 9_000_000;
  // The shape that hid the first revision's defect: traffic that never pauses.
  // Anchoring expiry to the last attempt means a caller calling faster than the
  // window never rolls its own, so its per-window budget silently becomes a
  // lifetime one. Two seconds apart is 30 upgrades per window against a limit of
  // 50 -- comfortably honest -- so every refusal here is the bug and not the
  // budget. Four hours of it is 7,200 upgrades against that same limit of 50.
  const spacingMs = 2_000;
  const perWindow = CONNECTION_ADMISSION_WINDOW_MS / spacingMs;
  expect(perWindow).toBeLessThan(GAMEPLAY_CONNECTIONS_PER_WINDOW);
  const upgrades = (4 * 3_600_000) / spacingMs;
  let refused = 0;
  for (let index = 0; index < upgrades; index += 1) {
    const at = start + index * spacingMs;
    if (index % 30 === 0) {
      admission.prune(at);
    }
    if (!admission.admit('198.51.100.7', '/ws', at).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);
});

test('a refused upgrade neither spends budget nor extends the caller window', () => {
  const admission = createConnectionAdmission(false);
  const start = 4_000_000;

  // Spend the budget, then keep attempting while refused. If a refusal were
  // charged it would move `lastAttempt`; if expiry read that instead of the
  // window start, the window would never roll and the refusal would be
  // permanent rather than lasting out the window.
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW; attempt += 1) {
    expect(admission.admit('192.0.2.7', '/ws', start + attempt).accepted).toBe(true);
  }
  expect(admission.admit('192.0.2.7', '/ws', start + 1_000)).toMatchObject({
    accepted: false,
    firstRejection: true,
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
  expect(admission.admit('192.0.2.7', '/ws', start + 59_000).accepted).toBe(false);

  // The window is anchored to the first accepted upgrade, so it rolls on time
  // and the refused attempts cost this caller nothing.
  expect(
    admission.admit('192.0.2.7', '/ws', start + CONNECTION_ADMISSION_WINDOW_MS + 1)
  ).toMatchObject({ accepted: true, count: 1 });
});

test('a fleet the edge cannot attribute keeps the budget it had when attributed', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_000_000;

  // The case an earlier revision got wrong, and the reason both lanes now size
  // this bucket by the same rule. Its gameplay budget came from the retry
  // ladder, so a fleet whose pilots each drop TWICE inside one window -- 12
  // upgrades each, far inside the 50 they hold when attributed -- was admitted
  // in full when attributed and lost exactly half when not. "Half the pilots
  // refused" is the outcome this bucket exists to prevent.
  const perPilot = 2 * WORST_HONEST_UPGRADES_PER_PILOT;
  expect(perPilot).toBeLessThan(GAMEPLAY_CONNECTIONS_PER_WINDOW);
  let refused = 0;
  for (let attempt = 0; attempt < MAX_PLAYERS * perPilot; attempt += 1) {
    if (!admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);

  // Parity, stated as the invariant rather than as a number: the shared bucket
  // may spend exactly what a full fleet may spend when the edge can tell its
  // pilots apart.
  expect(UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW).toBe(
    MAX_PLAYERS * GAMEPLAY_CONNECTIONS_PER_WINDOW
  );
  expect(UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW).toBe(MAX_PLAYERS * LOG_CONNECTIONS_PER_WINDOW);
});

test('the tracking ceiling bounds the bucket map on an unauthenticated path', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_200_000;

  // Re-keying from the socket peer to the forwarded address made this map
  // attacker-diverse, and /logs reaches admit with no auth and no handshake, so
  // without a ceiling a caller presenting distinct addresses grows it without
  // limit until the container dies. Drive well past the ceiling.
  for (let index = 0; index < MAX_TRACKED_ADDRESSES * 3; index += 1) {
    admission.admit(`10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`, '/logs', now);
  }
  expect(admission.size()).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);

  // The refusal says which bound stopped it, because an operator reading one
  // address over its own budget and the whole map being full needs to tell them
  // apart.
  expect(admission.admit('203.0.113.77', '/logs', now)).toMatchObject({
    accepted: false,
    scope: 'tracking',
    limit: MAX_TRACKED_ADDRESSES,
  });

  // A caller that already holds a bucket is unaffected by a full map: the
  // ceiling is checked only where a new key would be inserted.
  expect(admission.admit('10.0.0.0', '/logs', now).accepted).toBe(true);

  // And the map drains once the windows roll rather than staying full forever.
  admission.prune(now + CONNECTION_ADMISSION_WINDOW_MS + 1);
  expect(admission.size()).toBe(0);
});

test('the lane backstop is above every honest demand, so it refuses no honest caller', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_400_000;

  // The backstop exists to bound a bypass of per-address attribution, not to
  // ration honest traffic. An earlier revision sized it from the retry ladder,
  // which put it BELOW the sum of the per-address budgets a full fleet holds,
  // so spending it refused honest callers and became a denial of service.
  // It is now that sum plus the shared bucket, which is every way the limiter
  // can legitimately be spent at once.
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBe(
    MAX_PLAYERS * GAMEPLAY_CONNECTIONS_PER_WINDOW + UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW
  );
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL).toBe(
    MAX_PLAYERS * LOG_CONNECTIONS_PER_WINDOW + UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW
  );
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBeGreaterThan(
    UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW
  );

  // Driven, not only asserted: the shared bucket fully spent AND a full fleet
  // each spending its own budget, in one window, with nothing refused by the
  // backstop.
  let refusedByLane = 0;
  for (let attempt = 0; attempt < UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW; attempt += 1) {
    if (admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).scope === 'lane') {
      refusedByLane += 1;
    }
  }
  for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
    for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW; attempt += 1) {
      if (admission.admit(`198.51.100.${pilot}`, '/ws', now).scope === 'lane') {
        refusedByLane += 1;
      }
    }
  }
  expect(refusedByLane).toBe(0);

  // One more is over the backstop, and it says so.
  expect(admission.admit('203.0.113.9', '/ws', now)).toMatchObject({
    accepted: false,
    scope: 'lane',
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
});

test('flooding the bucket a caller can choose cannot refuse an attributed pilot', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_500_000;

  // The regression this guards: an earlier revision bounded every address in a
  // lane by one total AND gave the unattributed bucket that same total as its
  // own budget. Withholding the header then selected the one key that could
  // spend the whole lane, and independent review reproduced one source refusing
  // 488 of 600 honest joins from a single machine, indefinitely. Spend the
  // shared budget to its limit and past it, from the key a caller can pick.
  let accepted = 0;
  for (let attempt = 0; attempt < UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW + 50; attempt += 1) {
    if (admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted) {
      accepted += 1;
    }
  }
  expect(accepted).toBe(UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW);

  // Attributed pilots are untouched: a full fleet still joins, each on its own
  // budget, in the same window the flood is still running.
  let refused = 0;
  for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
    if (!admission.admit(`203.0.113.${pilot}`, '/ws', now).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);

  // And the diagnostics lane is not collateral either.
  expect(admission.admit('203.0.113.1', '/logs', now).accepted).toBe(true);
});

test('a pilot can climb its whole retry ladder inside its own budget', () => {
  // The ladder is the client's, so the server restates its length and this pins
  // the two against each other: the server may not import src/.
  expect(WORST_HONEST_UPGRADES_PER_PILOT).toBe(1 + RECONNECT_DELAYS_MS.length);

  // What the ladder is still load-bearing for, now that no limit is derived
  // from it: a pilot's own budget has to cover the upgrade plus every rung, or
  // an honest reconnect is refused by its own budget.
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(WORST_HONEST_UPGRADES_PER_PILOT);
  expect(LOG_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(1);
});

test('prune drops the buckets of addresses that stopped calling, and keeps the rest', () => {
  const admission = createConnectionAdmission(false);
  const start = 7_000_000;

  // prune had no observing assertion at all, so the rewrite that split one
  // timestamp into two was unverified: a prune reading the window start instead
  // of the last attempt would evict a caller that is still mid-window.
  for (let pilot = 0; pilot < 10; pilot += 1) {
    admission.admit(`198.51.100.${pilot}`, '/ws', start);
  }
  expect(admission.size()).toBe(10);

  // Half keep calling right up to the prune; half fall silent after `start`.
  const later = start + CONNECTION_ADMISSION_WINDOW_MS + 1;
  for (let pilot = 0; pilot < 5; pilot += 1) {
    admission.admit(`198.51.100.${pilot}`, '/ws', later);
  }
  admission.prune(later);
  expect(admission.size()).toBe(5);

  // The survivors are the ones still calling, and a pruned address returns with
  // a fresh budget rather than a remembered one.
  expect(admission.admit('198.51.100.0', '/ws', later)).toMatchObject({ accepted: true });
  expect(admission.admit('198.51.100.9', '/ws', later)).toMatchObject({
    accepted: true,
    count: 1,
  });
});

test('prune never hands a caller mid-spend a fresh budget', () => {
  const admission = createConnectionAdmission(false);
  const start = 7_500_000;

  // The property prune must not break, and the only one about it that a test
  // can observe: a caller part-way through its budget keeps that spend across a
  // prune. Evicting a live bucket would reset it, which is a rate limiter that
  // forgets -- worth guarding even though the choice between the bucket's two
  // timestamps is not itself observable.
  for (let attempt = 0; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW - 1; attempt += 1) {
    expect(admission.admit('192.0.2.50', '/ws', start + attempt).accepted).toBe(true);
  }
  admission.prune(start + 1_000);
  expect(admission.admit('192.0.2.50', '/ws', start + 1_001)).toMatchObject({
    accepted: true,
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });
  expect(admission.admit('192.0.2.50', '/ws', start + 1_002).accepted).toBe(false);
});

test('a header that is not an address cannot mint a bucket of its own', () => {
  const admission = createConnectionAdmission(false);
  const now = 8_000_000;

  // End to end through the composition rather than the resolver alone: a caller
  // sending text, or appending its own value behind the edge, lands in the
  // shared bucket and cannot carve out a private per-address budget.
  for (const headers of [
    { 'x-real-ip': 'not-an-address' },
    { 'x-real-ip': '203.0.113.42, 9.9.9.9' },
    { 'x-real-ip': ['203.0.113.42', '9.9.9.9'] },
    {},
  ]) {
    const charged = upgradeChargeAddress(request(headers, '172.16.0.1'), true);
    expect(charged).toBe(UNATTRIBUTED_CLIENT);
    expect(admission.admit(charged, '/ws', now).limit).toBe(
      UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW
    );
  }
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

test('a full fleet forwards its records after a deploy without one refusal', () => {
  const admission = createConnectionAdmission(false);
  const now = 6_500_000;

  // The telemetry twin of the gameplay ladder case, and the scenario the logs
  // budget is sized for: a deploy makes every pilot forward a record at once.
  // An earlier revision bounded this lane across all addresses at twice
  // MAX_PLAYERS, which refused a full fleet from its third reconnect round --
  // during a flap, which is when the records are worth reading.
  let refused = 0;
  for (let round = 0; round < LOG_CONNECTIONS_PER_WINDOW; round += 1) {
    for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
      if (!admission.admit(`198.51.100.${pilot}`, '/logs', now + round).accepted) {
        refused += 1;
      }
    }
  }
  expect(refused).toBe(0);

  // Each pilot is now exactly at its own documented budget, and the next one is
  // refused by that budget rather than by anything shared.
  expect(admission.admit('198.51.100.0', '/logs', now + LOG_CONNECTIONS_PER_WINDOW)).toMatchObject({
    accepted: false,
    lane: 'logs',
    count: LOG_CONNECTIONS_PER_WINDOW,
    limit: LOG_CONNECTIONS_PER_WINDOW,
  });
});

test('the runbook greps a string the server actually emits, and quotes the real limits', () => {
  // This exists because the two drifted apart within one change: the grep token
  // was documented against the string of the day, the emitter was reworded one
  // commit later, and the only new observability handle became unreachable as
  // documented. Six review lenses found it and no test could. Pinning the
  // literal means a future rewording fails here instead of silently breaking a
  // runbook an operator follows during an incident.
  const runbook = readFileSync('docs/diagnostics.md', 'utf8');
  const server = readFileSync('server/createServer.ts', 'utf8');

  const quoted = runbook.match(/Grep\n?`([^`]+)`/u);
  expect(quoted).not.toBeNull();
  const token = quoted?.[1] ?? '';
  expect(token.length).toBeGreaterThan(8);
  expect(server).toContain(token);

  // The limits the runbook quotes are the limits that ship. An operator sizing
  // an incident against stale numbers reaches the wrong conclusion as surely as
  // one grepping a string that is not there.
  for (const figure of [
    UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW,
    UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW,
    GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
    LOG_CONNECTIONS_PER_WINDOW_ALL,
    MAX_TRACKED_ADDRESSES,
  ]) {
    expect(runbook).toContain(figure.toLocaleString('en-US'));
  }
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
