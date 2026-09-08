import { afterEach, expect, test, vi } from 'vitest';
import { TestServerControl } from '../../integration/utils/test-server-control';

const cleanWorld = {
  isPaused: true,
  gameTime: 0,
  humanPlayers: 0,
  bots: 0,
  asteroids: 0,
  loot: 0,
  satellites: 0,
  satellitePickups: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
});

test('failed reset blocks the next scenario even when all players disconnected', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 500 }));
  await expect(TestServerControl.resetWorld()).rejects.toThrow('World reset failed: HTTP 500');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('a network failure blocks reset and the request carries an abort signal', async () => {
  const failure = new Error('reset request failed');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
  await expect(TestServerControl.resetWorld()).rejects.toBe(failure);
  expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  { players: 0 },
  { world: { ...cleanWorld, asteroids: -1 } },
  { world: { ...cleanWorld, gameTime: 'unknown' } },
  { world: { ...cleanWorld, humanPlayers: null } },
])('missing or corrupt world evidence cannot be treated as a clean arena: %j', async (body) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
  await expect(TestServerControl.getWorldDiagnostics()).rejects.toThrow('valid world diagnostics');
});

test('successful reset waits for verified empty world diagnostics', async () => {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(Response.json({ world: cleanWorld }));
  await expect(TestServerControl.resetWorld()).resolves.toBeUndefined();
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test.each([
  'bots',
  'asteroids',
  'loot',
  'satellites',
  'satellitePickups',
] as const)('remaining %s prevents a clean-world verdict', (field) => {
  expect(TestServerControl.isWorldClean({ ...cleanWorld, [field]: 1 })).toBe(false);
});
