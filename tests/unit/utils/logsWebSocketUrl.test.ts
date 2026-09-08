import { expect, test } from 'vitest';
import { logsWebSocketUrlFromGameplay } from '../../../src/utils/logsWebSocketUrl';

test('production gameplay URL maps /ws onto Railway /logs', () => {
  expect(
    logsWebSocketUrlFromGameplay(
      'wss://geoasteroids-production-2403.up.railway.app/ws',
      'www.georoids.com',
      true
    )
  ).toBe('wss://geoasteroids-production-2403.up.railway.app/logs');
});

test('without a gameplay URL, logs use the page host so Vite can proxy', () => {
  expect(logsWebSocketUrlFromGameplay(undefined, 'localhost:5173', false)).toBe(
    'ws://localhost:5173/logs'
  );
});

test('a trailing slash on /ws still maps to /logs', () => {
  expect(logsWebSocketUrlFromGameplay('ws://localhost:3001/ws/', 'localhost:5173', false)).toBe(
    'ws://localhost:3001/logs'
  );
});
