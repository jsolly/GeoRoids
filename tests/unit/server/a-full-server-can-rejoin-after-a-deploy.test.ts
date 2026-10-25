/* @vitest-environment node */

import type { IncomingMessage } from 'node:http';
import { expect, test } from 'vitest';
import { resolveClientAddress } from '../../../server/communication/clientAddress';
import {
  CONNECTION_ADMISSION_WINDOW_MS,
  createConnectionAdmission,
  GAMEPLAY_CONNECTIONS_PER_WINDOW,
  GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  LOG_CONNECTIONS_PER_WINDOW_ALL,
  MAX_PLAYERS,
} from '../../../server/communication/connectionAdmission';

function request(headers: Record<string, string>, remoteAddress?: string): IncomingMessage {
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

test('the lane ceiling bounds a caller that rotates its claimed address', () => {
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
    limit: GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL,
  });
  // The ceiling is a gameplay total: a diagnostic socket keeps its own.
  expect(admission.admit('10.9.9.9', '/logs', now + 1).accepted).toBe(true);
});

test('an upgrade the lane ceiling refused neither spends nor extends the caller window', () => {
  const admission = createConnectionAdmission(false);
  const start = 4_000_000;

  expect(admission.admit('192.0.2.7', '/ws', start).accepted).toBe(true);
  // Other callers take the gameplay lane to its ceiling in the same window.
  for (let attempt = 1; attempt < GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL; attempt += 1) {
    admission.admit(`10.2.${Math.floor(attempt / 256)}.${attempt % 256}`, '/ws', start);
  }
  expect(admission.admit('192.0.2.7', '/ws', start + 59_000)).toMatchObject({
    accepted: false,
    laneExhausted: true,
  });

  // That refusal left this caller's window anchored to its own last accepted
  // upgrade, so the window still rolls on time and the attempt cost it nothing.
  // Charging before reading the ceiling would hold a retrying caller's window
  // open forever and bill them for upgrades they never got.
  expect(
    admission.admit('192.0.2.7', '/ws', start + CONNECTION_ADMISSION_WINDOW_MS + 1)
  ).toMatchObject({
    accepted: true,
    count: 1,
  });
});

test('the ceilings leave room for an honest fleet and keep logs tighter', () => {
  // A six-second stall retries on a 0.5/1/2/4/8 s ladder, so a full server can
  // legitimately spend five upgrades per pilot inside one window.
  expect(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL).toBeGreaterThanOrEqual(MAX_PLAYERS * 5);
  expect(LOG_CONNECTIONS_PER_WINDOW_ALL).toBeLessThan(GAMEPLAY_CONNECTIONS_PER_WINDOW_ALL);
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
});
