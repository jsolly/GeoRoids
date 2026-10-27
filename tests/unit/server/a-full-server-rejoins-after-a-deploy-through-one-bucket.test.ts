/* @vitest-environment node */

import { expect, test } from 'vitest';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  LOG_CONNECTIONS_PER_WINDOW,
  MAX_PLAYERS,
  UPGRADES_PER_DROP_EPISODE,
} from '../../../server/communication/connectionAdmission';
import { RECONNECT_DELAYS_MS } from '../../../src/network/services/connectionReconnect';
import { MIN_SOCKET_GAP_MS } from '../../../src/utils/logForwarder';

/**
 * Behind Railway's public HTTP ingress every pilot is charged to the edge
 * proxy's address, so the fleet spends ONE bucket. These cases drive that
 * shape -- one address, a fleet's worth of traffic -- because it is the shape
 * production runs in and the one the old budgets were too small for.
 *
 * Every loop below is bounded by demand the CLIENT defines, never by the budget
 * under test, so shrinking a budget fails a case instead of shortening a loop.
 */
const EDGE = '198.51.100.1';
const LOG_SOCKETS_PER_PILOT_CEILING = CONNECTION_ADMISSION_WINDOW_MS / MIN_SOCKET_GAP_MS;
/** A deploy closes every log socket; each pilot forwards again and may retry. */
const LOG_SOCKETS_PER_PILOT_ON_DEPLOY = 3;

test('a full fleet rejoins after a deploy without one refusal', () => {
  const admission = createConnectionAdmission(false);
  const start = 2_000_000;

  // The defect: a gameplay budget of 50 against MAX_PLAYERS of 100 sat below
  // capacity, so a deploy that re-upgrades the whole fleet had its 51st
  // reconnect refused with 429 and a full server could not come back.
  let refused = 0;
  for (let rung = 0; rung <= RECONNECT_DELAYS_MS.length; rung += 1) {
    const at = start + RECONNECT_DELAYS_MS.slice(0, rung).reduce((sum, ms) => sum + ms, 0);
    for (let pilot = 0; pilot < MAX_PLAYERS; pilot += 1) {
      if (!admission.admit(EDGE, '/ws', at).accepted) {
        refused += 1;
      }
    }
  }
  expect(refused).toBe(0);
});

test('a full fleet forwards its records after a deploy without one refusal', () => {
  const admission = createConnectionAdmission(false);
  const now = 3_000_000;

  // The same defect, worse: the diagnostics lane allowed 6 sockets for the
  // entire server, and a deploy makes every pilot forward a record. The loop is
  // the fleet's demand on a deploy, not the budget under test, so a budget below
  // it refuses here.
  let refused = 0;
  const fleetDemand = MAX_PLAYERS * LOG_SOCKETS_PER_PILOT_ON_DEPLOY;
  for (let socket = 0; socket < fleetDemand; socket += 1) {
    if (!admission.admit(EDGE, '/logs', now + socket).accepted) {
      refused += 1;
    }
  }
  expect(refused).toBe(0);
});

test('each budget covers a full fleet of the demand its client defines', () => {
  // The ladder and the socket floor are the client's, so the server restates
  // them and these pin the restatements against the real values: the server may
  // not import src/. Asserting the budget against the product of the server's
  // own constants would restate its definition and could not fail.
  expect(UPGRADES_PER_DROP_EPISODE).toBe(1 + RECONNECT_DELAYS_MS.length);

  // What matters is that each budget still covers a fleet of client-defined
  // demand. These fail if a budget shrinks, if the fleet grows, or if the
  // client's ladder changes underneath them.
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(
    MAX_PLAYERS * (1 + RECONNECT_DELAYS_MS.length)
  );
  expect(LOG_CONNECTIONS_PER_WINDOW).toBeGreaterThanOrEqual(
    MAX_PLAYERS * LOG_SOCKETS_PER_PILOT_ON_DEPLOY
  );

  // The log lane is deliberately held BELOW the twelve attempts a window the
  // forwarder's five-second floor permits each pilot, because every admitted
  // socket brings a fresh 256 KiB ingress quota and client.log retains 20 MiB.
  // Raising it to that ceiling fails here on purpose: size the rotation first.
  expect(LOG_SOCKETS_PER_PILOT_CEILING).toBe(12);
  expect(LOG_CONNECTIONS_PER_WINDOW).toBeLessThan(MAX_PLAYERS * LOG_SOCKETS_PER_PILOT_CEILING);
});

test('the budget is still a budget: the fleet is refused past it, and recovers', () => {
  const admission = createConnectionAdmission(false);
  const start = 4_000_000;

  // Raising a limit is only safe if it is still enforced. Spend it exactly, then
  // confirm the next upgrade is refused and names the budget it exceeded.
  for (let upgrade = 0; upgrade < GAMEPLAY_CONNECTIONS_PER_WINDOW; upgrade += 1) {
    expect(admission.admit(EDGE, '/ws', start).accepted).toBe(true);
  }
  expect(admission.admit(EDGE, '/ws', start)).toMatchObject({
    accepted: false,
    lane: 'gameplay',
    firstRejection: true,
    count: GAMEPLAY_CONNECTIONS_PER_WINDOW,
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW,
  });

  // A refusal must not extend the window, or a fleet that keeps retrying while
  // refused pushes its own unlock further away with every attempt and never
  // recovers. Retry half a window in, while still refused, then confirm the
  // window rolls on the last ACCEPTED attempt and not on that retry. Asserting
  // only the second line passes even when a refusal does extend the window,
  // which is what this case was written for.
  const halfway = start + CONNECTION_ADMISSION_WINDOW_MS / 2;
  expect(admission.admit(EDGE, '/ws', halfway).accepted).toBe(false);
  expect(admission.admit(EDGE, '/ws', start + CONNECTION_ADMISSION_WINDOW_MS + 1).accepted).toBe(
    true
  );
});

test('a budget is spent per busy period, not refilled per minute', () => {
  const admission = createConnectionAdmission(false);
  const start = 5_000_000;

  // admit() rolls a bucket only after a full window with no ACCEPTED upgrade in
  // the lane, so accepted upgrades accumulate with no decay while the lane stays
  // busy. One upgrade every half window -- two a minute, a fraction of the
  // budget's size -- still spends the whole budget and is then refused. The
  // budgets are therefore headroom for a burst, not a rate per minute, and the
  // documentation must not promise a minute. The shape is the limiter's own and
  // predates these values; what changes here is how far away this point sits.
  const step = CONNECTION_ADMISSION_WINDOW_MS / 2;
  for (let upgrade = 0; upgrade < GAMEPLAY_CONNECTIONS_PER_WINDOW; upgrade += 1) {
    expect(admission.admit(EDGE, '/ws', start + upgrade * step).accepted).toBe(true);
  }
  const elapsed = GAMEPLAY_CONNECTIONS_PER_WINDOW * step;
  expect(elapsed).toBeGreaterThan(100 * CONNECTION_ADMISSION_WINDOW_MS);
  expect(admission.admit(EDGE, '/ws', start + elapsed).accepted).toBe(false);

  // It does clear, but only on a quiet lane: one full window with nothing
  // accepted, which is what a deploy gets for free by starting a new process.
  expect(
    admission.admit(EDGE, '/ws', start + elapsed + CONNECTION_ADMISSION_WINDOW_MS + 1).accepted
  ).toBe(true);
});
