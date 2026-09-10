import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Roid } from '../../../../src/entities/roid/Roid';
import { Ship } from '../../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../../src/physics/collision/CollisionManager';

// Mock NetworkManager for integration testing
const mockSendMessage = vi.fn();
const mockGetLocalPlayerId = vi.fn(() => 'local-player-123');

vi.mock('../../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      isConnected: true,
      getLocalPlayerId: mockGetLocalPlayerId,
      sendMessage: mockSendMessage,
      updatePlayerState: vi.fn(),
    })),
  },
}));

// Mock logger to keep output clean
vi.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Integration: Local player roid collisions', () => {
  let collisionManager: CollisionManager;
  let localShip: Ship;
  let roid: Roid;

  beforeEach(() => {
    vi.clearAllMocks();
    collisionManager = CollisionManager.getInstance();

    // Create a local ship with a random UUID id (default). Intentionally do NOT align with player id.
    localShip = new Ship({ isLocalPlayer: true });
    localShip.position = { x: 400, y: 300 };
    localShip.r = 15;

    // Clear spawn protection to allow collisions
    localShip.blinkCount = 0;
    localShip.spawnProtectionTimer = 0;

    // Place a roid directly overlapping the ship so collision detection triggers without mocks
    roid = new Roid({ x: 400, y: 300 }, 25);
    roid.velocity = { x: 0, y: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test.each([25, 12.5, 6.25])(
    'a collision with a radius-%s asteroid waits for server authority',
    (radius) => {
      const localPlayer = { ship: localShip, id: 'local-player-123', type: 'local' as const };
      const initialHealth = localShip.health;
      roid.r = radius;

      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      expect(localShip.health).toBe(initialHealth);
      expect(roid.pendingDestruction).toBeFalsy();
      expect(mockSendMessage).not.toHaveBeenCalled();
    }
  );
});
