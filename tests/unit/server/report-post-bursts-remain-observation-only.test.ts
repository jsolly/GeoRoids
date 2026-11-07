// @vitest-environment node
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { expect, test, vi } from 'vitest';
import { createDebugReportHttp } from '../../../server/debugReports/http';
import { createReportPostObservation } from '../../../server/debugReports/postObservation';

test('local forwarded addresses cannot split a source burst while Railway requires valid ingress identities', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  try {
    function observe(railwayIngress: boolean, addresses: (string | undefined)[]) {
      const http = createDebugReportHttp(undefined, {
        allowedOrigins: [],
        sameOriginClient: false,
        railwayIngress,
        health: () => ({}),
      });
      for (const address of addresses) {
        const socket = new Socket();
        Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
        const req = new IncomingMessage(socket);
        req.method = 'POST';
        req.url = '/debug-reports';
        if (address !== undefined) {
          req.headers['x-real-ip'] = address;
        }
        const res = new ServerResponse(req);
        try {
          expect(http.handle(req, res)).toBe(true);
          expect(res.statusCode).toBe(503);
        } finally {
          res.destroy();
          req.destroy();
          socket.destroy();
        }
      }
      return http.observation();
    }
    expect(observe(false, ['192.0.2.1', '192.0.2.2'])).toMatchObject({
      requests: 2,
      peakRequestsPerIpMinute: 2,
      unattributedRequests: 0,
      ipMinuteBursts: { one: 0, twoToFive: 1 },
    });
    expect(observe(true, ['192.0.2.1', '2001:db8::1', undefined, 'not-an-ip'])).toMatchObject({
      requests: 4,
      peakRequestsPerIpMinute: 1,
      unattributedRequests: 2,
      ipMinuteBursts: { one: 2, twoToFive: 0 },
    });
  } finally {
    clock.mockRestore();
  }
});

test('IP-minute evidence crosses sixty without changing completion outcomes and rolls at the minute boundary', () => {
  let now = 1_800_000_059_500;
  const observation = createReportPostObservation(() => now);
  for (let index = 0; index < 61; index++) {
    observation.start('192.0.2.1')(415);
  }
  observation.start('2001:db8::1')(202);
  const first = observation.read();
  expect(first).toMatchObject({
    mode: 'observe-only',
    requests: 62,
    peakRequestsPerIpMinute: 61,
    requestsAboveSixtyPerIpMinute: 1,
    outcomes: { clientRejected: 61, accepted: 1 },
    ipMinuteBursts: { one: 1, overSixty: 1 },
  });
  now += 500;
  observation.start('192.0.2.1')(429);
  expect(observation.read()).toMatchObject({
    requests: 63,
    requestsAboveSixtyPerIpMinute: 1,
    outcomes: { accepted: 1, rateLimited: 1, clientRejected: 61 },
    ipMinuteBursts: { one: 2, overSixty: 1 },
  });
  expect(first.requests).toBe(62);
  expect(first.outcomes.rateLimited).toBe(0);
  expect(JSON.stringify(observation.read())).not.toMatch(/192\.0\.2|2001:db8/u);
});

test('tracking capacity loss and unavailable identities stay visible and capacity resets next minute', () => {
  let now = 0;
  const observation = createReportPostObservation(() => now);
  const capacity = observation.read().addressCapacityPerMinute;
  for (let index = 0; index < capacity; index++) {
    observation.start(`owned-${index}`)(202);
  }
  observation.start('untracked')(503);
  observation.start('owned-0')(400);
  observation.start(undefined)(503);
  expect(observation.read()).toMatchObject({
    requests: capacity + 3,
    capacityExcludedRequests: 1,
    unattributedRequests: 1,
    peakRequestsPerIpMinute: 2,
    ipMinuteBursts: { one: capacity - 1, twoToFive: 1 },
  });
  now = 60_000;
  observation.start('untracked')(202);
  expect(observation.read()).toMatchObject({
    capacityExcludedRequests: 1,
    ipMinuteBursts: { one: capacity, twoToFive: 1 },
  });
});

test('an aborted response is counted once even if completion is reported again', () => {
  const observation = createReportPostObservation();
  const complete = observation.start(undefined);
  complete(null);
  complete(202);
  expect(observation.read().outcomes).toEqual({
    accepted: 0,
    rateLimited: 0,
    clientRejected: 0,
    unavailable: 0,
    other: 0,
    aborted: 1,
  });
});
