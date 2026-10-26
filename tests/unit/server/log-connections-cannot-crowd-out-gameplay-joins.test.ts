/* @vitest-environment node */

import { expect, test } from 'vitest';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  connectionLimitsDisabled,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  LOG_CONNECTIONS_PER_WINDOW,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
  MAX_TRACKED_ADDRESSES,
  UNATTRIBUTED_CLIENT,
  UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW,
  UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW,
} from '../../../server/communication/connectionAdmission';

test('production enables connection budgets and test or development runs leave them off', () => {
  expect(LOG_CONNECTIONS_PER_WINDOW).toBe(6);
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW).toBe(50);
  expect(CONNECTION_ADMISSION_WINDOW_MS).toBe(60_000);
  // Pinned as literals like their siblings, so a derived budget cannot move both
  // sides of its own sizing assertion. The relationship to the client's retry
  // ladder is asserted in a-full-server-can-rejoin-after-a-deploy.
  expect(UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW).toBe(5000);
  expect(UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW).toBe(600);
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBe(10_000);
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL).toBe(1200);
  expect(MAX_TRACKED_ADDRESSES).toBe(1024);
  expect(connectionLimitsDisabled({ nodeEnv: 'production' })).toBe(false);
  expect(connectionLimitsDisabled({ nodeEnv: 'test', vitest: 'true' })).toBe(true);
  expect(connectionLimitsDisabled({ nodeEnv: 'development' })).toBe(true);
  expect(connectionLimitsDisabled({ nodeEnv: 'production', processNodeEnv: 'test' })).toBe(true);
  expect(connectionLimitsDisabled({ nodeEnv: 'production', vitest: 'true' })).toBe(true);
});

test('a log-socket burst keeps its own budget and leaves gameplay joins open', () => {
  const admission = createConnectionAdmission(false);
  const now = 1_000_000;
  for (let index = 0; index < LOG_CONNECTIONS_PER_WINDOW; index += 1) {
    expect(admission.admit('203.0.113.8', '/logs', now).accepted).toBe(true);
  }

  const rejected = admission.admit('203.0.113.8', '/logs', now + 400);
  expect(rejected).toMatchObject({
    accepted: false,
    lane: 'logs',
    firstRejection: true,
    count: LOG_CONNECTIONS_PER_WINDOW,
    limit: LOG_CONNECTIONS_PER_WINDOW,
  });
  expect(admission.admit('203.0.113.8', '/logs', now + 800).firstRejection).toBe(false);
  expect(admission.admit('203.0.113.8', '/ws', now + 800)).toMatchObject({
    accepted: true,
    lane: 'gameplay',
  });

  expect(
    admission.admit('203.0.113.8', '/logs', now + CONNECTION_ADMISSION_WINDOW_MS).accepted
  ).toBe(false);
  expect(
    admission.admit('203.0.113.8', '/logs', now + CONNECTION_ADMISSION_WINDOW_MS + 1).accepted
  ).toBe(true);
});

test('gameplay joins and log sockets do not spend one shared connection budget', () => {
  const admission = createConnectionAdmission(false);
  const now = 5_000;
  for (let index = 0; index < GAMEPLAY_CONNECTIONS_PER_WINDOW; index += 1) {
    expect(admission.admit('203.0.113.9', '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit('203.0.113.9', '/ws', now + 1).accepted).toBe(false);
  expect(admission.admit('203.0.113.9', '/logs', now + 1).accepted).toBe(true);
  expect(admission.admit('203.0.113.10', '/logs', now).accepted).toBe(true);
});

test('the shared unattributed budget is per lane, not one pool for both', () => {
  const admission = createConnectionAdmission(false);
  const now = 2_000_000;
  for (let index = 0; index < UNATTRIBUTED_GAMEPLAY_CONNECTIONS_PER_WINDOW; index += 1) {
    expect(admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted).toBe(true);
  }
  expect(admission.admit(UNATTRIBUTED_CLIENT, '/ws', now).accepted).toBe(false);
  // A gameplay flood the edge cannot attribute must not take diagnostics with
  // it; that is the moment the records are worth reading.
  expect(admission.admit(UNATTRIBUTED_CLIENT, '/logs', now)).toMatchObject({
    accepted: true,
    limit: UNATTRIBUTED_LOG_CONNECTIONS_PER_WINDOW,
  });
});

test('disabled admission accepts a log storm without touching the gameplay lane', () => {
  const admission = createConnectionAdmission(true);
  for (let index = 0; index < LOG_CONNECTIONS_PER_WINDOW + 10; index += 1) {
    expect(admission.admit('203.0.113.11', '/logs', index).accepted).toBe(true);
  }
  expect(admission.admit('203.0.113.11', '/ws', 0).accepted).toBe(true);
});
