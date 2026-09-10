import { expect, test } from 'vitest';
import type { PlayerJoin } from '../../../shared-types';
import { ROID } from '../../../src/constants';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';

type TestSocket = {
  readyState: number;
  send: (raw: string) => void;
};

type TestConnectionManager = {
  state: { isConnected: boolean; socket: TestSocket | null };
  localPlayerId: string;
  seenAsteroidIds: Set<string>;
  hasInitializedAsteroidsForConnection: boolean;
  handleJoined: (data: PlayerJoin) => void;
};

test('rejoining after a server restart requests asteroids despite a cached belt', () => {
  const manager = ConnectionManager.getInstance() as unknown as TestConnectionManager;
  const sent: unknown[] = [];

  manager.state = {
    isConnected: true,
    socket: {
      // `initializeAsteroids` only needs a connected socket's send method.
      readyState: 1,
      send: (raw) => sent.push(JSON.parse(raw)),
    },
  };
  manager.localPlayerId = '';
  manager.seenAsteroidIds = new Set(['server-asteroid-0']);
  manager.hasInitializedAsteroidsForConnection = true;

  manager.handleJoined({
    id: 'server-player-1',
    name: 'Pilot',
    position: { x: 0, y: 0 },
    color: '#fff',
    snapshotVersion: 1,
    asteroidInteractions: 1,
    resumeToken: 'a'.repeat(64),
  });

  expect(sent).toEqual([
    {
      type: 'initAsteroids',
      id: 'server-player-1',
      data: { asteroidCount: ROID.INITIAL_ROID_COUNT },
      timestamp: expect.any(Number),
    },
  ]);
  expect(manager.hasInitializedAsteroidsForConnection).toBe(true);
});
