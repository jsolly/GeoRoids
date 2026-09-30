import { afterEach, expect, test, vi } from 'vitest';
import {
  getFixtureState,
  getWorldDiagnostics,
  isWorldClean,
  placePlayer,
  resetWorld,
} from '../../integration/utils/test-server-control';

const cleanWorld = {
  isPaused: true,
  gameTime: 0,
  players: 0,
  asteroids: 0,
  loot: 0,
  satellitePickups: 0,
  loop: { discardedDebtMs: 0, longestStallMs: 0, stalls: 0 },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('failed reset blocks the next scenario even when all players disconnected', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 500 }));
  await expect(resetWorld()).rejects.toThrow('World reset failed: HTTP 500');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('a network failure blocks reset and the request carries an abort signal', async () => {
  const failure = new Error('reset request failed');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
  await expect(resetWorld()).rejects.toBe(failure);
  expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  { players: 0 },
  { world: { ...cleanWorld, asteroids: -1 } },
  { world: { ...cleanWorld, gameTime: 'unknown' } },
  { world: { ...cleanWorld, players: null } },
])('missing or corrupt world evidence cannot be treated as a clean arena: %j', async (body) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
  await expect(getWorldDiagnostics()).rejects.toThrow('valid world diagnostics');
});

test('successful reset waits for verified empty world diagnostics', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(
      Response.json({ world: cleanWorld, seed: 42, sockets: { total: 0, open: 0 }, players: [] })
    );
  await expect(resetWorld()).resolves.toBeUndefined();
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test.each(['asteroids', 'loot', 'satellitePickups'] as const)(
  'remaining %s prevents a clean-world verdict',
  (field) => {
    expect(isWorldClean({ ...cleanWorld, [field]: 1 })).toBe(false);
  }
);

test('an empty world waits for closing owned sockets to leave before reset completes', async () => {
  vi.useFakeTimers();
  const state = { world: cleanWorld, seed: 42, players: [] };
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ status: 'reset' }))
    .mockResolvedValueOnce(Response.json({ ...state, sockets: { total: 1, open: 0 } }))
    .mockResolvedValueOnce(Response.json({ ...state, sockets: { total: 0, open: 0 } }));
  const reset = resetWorld();
  await vi.advanceTimersByTimeAsync(200);
  await expect(reset).resolves.toBeUndefined();
  expect(fetchSpy).toHaveBeenCalledTimes(3);
});

test('a placement rejection retains the actual HTTP body and makes one request', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json(
        { error: 'Live fixture player not found', reason: 'dead', health: 0 },
        { status: 404 }
      )
    );
  await expect(placePlayer('dead-pilot', { x: 100, y: 0 })).rejects.toThrow(
    'HTTP 404 {"error":"Live fixture player not found","reason":"dead","health":0}'
  );
  expect(fetchSpy).toHaveBeenCalledOnce();
});

test('fixture observation failure cannot pass a reset completion barrier', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ status: 'reset' }))
    .mockResolvedValueOnce(Response.json({ error: 'observation unavailable' }, { status: 503 }));
  await expect(resetWorld()).rejects.toThrow('Fixture observation failed: HTTP 503');
});

test('fixture observations reject missing transport evidence', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ world: cleanWorld, seed: 42, players: [] })
  );
  await expect(getFixtureState()).rejects.toThrow('invalid state');
});

test.each([
  { total: -1, open: 0 },
  { total: 0, open: 1 },
  { total: 1.5, open: 0 },
])('fixture observations reject impossible socket membership: %j', async (sockets) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ world: cleanWorld, seed: 42, players: [], sockets })
  );
  await expect(getFixtureState()).rejects.toThrow('invalid state');
});
