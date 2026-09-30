/* @vitest-environment node */
import type { Page } from 'playwright';
import { afterEach, expect, test, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../../integration/utils/test-server-control', () => ({
  placePlayer: () => Promise.resolve({ motionEpoch: 2 }),
  getFixtureState: boundary.observe,
}));

import { GameInteractions } from '../../integration/utils/game-interactions';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function pilot(afterWait = () => {}) {
  const ship = {
    health: 100,
    exploding: false,
    playerMotion: { epoch: 2 },
    position: { x: 7, y: 8 },
    velocity: { x: 0, y: 0 },
  };
  const player = { ship };
  vi.stubGlobal('window', {
    gameController: {
      getCurrPlayer: () => player,
      getPlayerManager: () => ({ getLocalPlayer: () => player }),
      getNetworkManager: () => ({ getLocalPlayerId: () => 'pilot', isConnected: true }),
    },
  });
  const page = {
    evaluate: (callback: (argument: unknown) => unknown, argument: unknown) =>
      Promise.resolve().then(() => callback(argument)),
    waitForFunction: (callback: (argument: unknown) => unknown, argument: unknown) =>
      Promise.resolve().then(() => {
        if (!callback(argument)) {
          throw new Error('Acknowledged fixture was not ready');
        }
        afterWait();
      }),
  } as unknown as Page;
  return { ship, game: new GameInteractions(page) };
}

test.each([
  { event: 'death', health: 0, exploding: true, epoch: 2 },
  { event: 'explosion', health: 100, exploding: true, epoch: 2 },
  { event: 'reconnect', health: 100, exploding: false, epoch: 3 },
])(
  'a $event between acknowledged placement and alignment fails without moving the pilot',
  async ({ health, exploding, epoch }) => {
    const { ship, game } = pilot();
    boundary.observe.mockImplementation(() => {
      // The server observation acknowledges epoch 2; the browser changes before its next task.
      ship.health = health;
      ship.exploding = exploding;
      ship.playerMotion.epoch = epoch;
      return Promise.resolve({
        players: [{ id: 'pilot', health: 100, exploding: false, socketState: 1, motionEpoch: 2 }],
        sockets: { total: 1, open: 1 },
      });
    });
    await expect(game.placeControlledShipAt(900, 1000)).rejects.toThrow(
      'Controlled placement superseded before alignment'
    );
    expect(ship.position).toEqual({ x: 7, y: 8 });
    expect(ship.health).toBe(health);
    expect(ship.playerMotion.epoch).toBe(epoch);
  }
);

test('an intentional lethal placement keeps a superseding death pose without reviving the pilot', async () => {
  const fixture = pilot(() => {
    fixture.ship.health = 0;
    fixture.ship.exploding = true;
    fixture.ship.playerMotion.epoch = 3;
  });
  await expect(fixture.game.placeShipAt(900, 1000)).resolves.toBeUndefined();
  expect(fixture.ship.position).toEqual({ x: 7, y: 8 });
  expect(fixture.ship.health).toBe(0);
  expect(fixture.ship.playerMotion.epoch).toBe(3);
});
