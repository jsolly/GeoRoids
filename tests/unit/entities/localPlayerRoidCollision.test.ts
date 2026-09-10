import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DAMAGE, DEBUG } from '../../../src/constants';
import { Roid } from '../../../src/entities/roid/Roid';
import { Ship } from '../../../src/entities/ship/Ship';
import { NetworkManager } from '../../../src/network/networkManager';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';

// Mock NetworkManager
const mockSendMessage = vi.fn();
const mockGetLocalPlayerId = vi.fn((): string | null => 'local-player-123');

vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      isConnected: true,
      getLocalPlayerId: mockGetLocalPlayerId,
      sendMessage: mockSendMessage,
    })),
  },
}));

// Mock logger
vi.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock collision detection
vi.mock('../../../src/physics/collision/collisionDetection', () => ({
  checkShipCollision: vi.fn(),
  checkLaserAsteroidCollision: vi.fn(),
  checkLaserAsteroidCollisionSwept: vi.fn(),
  checkLaserShipCollision: vi.fn(),
  asteroidPointsForRadius: vi.fn((radius: number) => (radius >= 20 ? 50 : 100)),
}));

describe('Local Player Roid Collision Damage', () => {
  let collisionManager: CollisionManager;
  let networkManager: NetworkManager;
  let localPlayer: { ship: Ship; id: string; type: 'local' };
  let localShip: Ship;
  let roid: Roid;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create collision manager
    collisionManager = CollisionManager.getInstance();

    // Get mocked network manager
    networkManager = NetworkManager.getInstance();

    // Create local player ship
    localShip = new Ship();
    localShip.id = 'local-player-123';
    localShip.position = { x: 400, y: 300 };
    localShip.r = 15; // Ship radius

    // Create local player object
    localPlayer = { ship: localShip, id: 'local-player-123', type: 'local' as const };

    // Create roid positioned on the local player (as per DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER)
    roid = new Roid({ x: 400, y: 300 }, 25);
    // Override the random velocity to keep it stationary for testing
    roid.velocity = { x: 0, y: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Collision Detection', () => {
    test('detects collision between local player and roid', () => {
      // Verify the roid is positioned on the local player
      expect(roid.position.x).toBe(localShip.position.x);
      expect(roid.position.y).toBe(localShip.position.y);

      // Check that they should be colliding (overlapping radii)
      const distance = Math.sqrt(
        (roid.position.x - localShip.position.x) ** 2 +
          (roid.position.y - localShip.position.y) ** 2
      );
      expect(distance).toBe(0); // Same position
      expect(distance).toBeLessThan(localShip.r + roid.r); // Should be colliding
    });

    test('collision manager detects ship-asteroid collision', async () => {
      // Mock the collision detection to return true
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      console.log('Before collision check:');
      console.log('  Ship ID:', localShip.id);
      console.log('  Roid ID:', roid.id);
      console.log('  Ship position:', localShip.position);
      console.log('  Roid position:', roid.position);
      console.log('  Local player ID:', 'local-player-123');

      // Check collision
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      console.log('After collision check:');
      console.log('  Health:', localShip.health);
      console.log('  Network manager calls:', mockSendMessage.mock.calls.length);

      // Server owns ship↔asteroid health; the client must not apply or report it.
      expect(localShip.health).toBe(100);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Server-Authoritative Damage', () => {
    test('asteroid overlap does not apply local damage or send client reports', async () => {
      // Mock the collision detection to return true
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      const initialHealth = localShip.health;
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);
      expect(localShip.health).toBe(initialHealth);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('asteroid overlap does not request client-side splitting', async () => {
      // Mock the collision detection to return true
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      // Check collision
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Debug Settings Impact', () => {
    test('roids are not spawned on the local player during normal play', () => {
      // Spawning roids directly on the player instantly kills them, so this
      // collision-testing aid is disabled by default in the playable build.
      expect(DEBUG.ROIDS.PLACE_ON_LOCAL_PLAYER).toBe(false);
      expect(DEBUG.LOCAL_PLAYER.INVINCIBLE).toBe(false);
    });

    test('local player is not invincible in debug mode', () => {
      expect(DEBUG.LOCAL_PLAYER.INVINCIBLE).toBe(false);
      // Damage is applied by the server from authoritative overlap, not client reports
    });
  });

  describe('Damage Constants', () => {
    test('asteroid collision is an instant kill like the wall', () => {
      expect(DAMAGE.ASTEROID_COLLISION).toBe(DAMAGE.BOUNDARY_COLLISION);
      expect(DAMAGE.ASTEROID_COLLISION).toBe(100);
    });

    test('a raised shield does not report asteroid ram — server owns it', async () => {
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      localShip.requestShieldToggle();
      expect(localShip.shieldActive).toBe(true);
      mockSendMessage.mockClear();

      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      expect(localShip.health).toBe(100);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    test('local player does not report asteroid damage while blinking', async () => {
      localShip.blinkCount = 8;

      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      expect(networkManager.sendMessage).not.toHaveBeenCalled();
    });

    test('local player does not take damage while exploding', async () => {
      localShip.exploding = true;

      // Mock the collision detection to return true
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      const initialHealth = localShip.health;

      // Check collision - should be ignored due to exploding state
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      // Should not take damage while exploding
      expect(localShip.health).toBe(initialHealth);
      expect(networkManager.sendMessage).not.toHaveBeenCalled();
    });

    test('collision detection works correctly', async () => {
      // Mock the collision detection to return false
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(false);

      const initialHealth = localShip.health;

      // Check collision - should not trigger
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      // Should not take damage when not colliding
      expect(localShip.health).toBe(initialHealth);
      expect(networkManager.sendMessage).not.toHaveBeenCalled();
    });

    test('handles missing local player ID gracefully', async () => {
      mockGetLocalPlayerId.mockReturnValue(null);

      // Mock the collision detection to return true
      const { checkShipCollision } = await import(
        '../../../src/physics/collision/collisionDetection'
      );
      vi.mocked(checkShipCollision).mockReturnValue(true);

      // Check collision
      collisionManager.checkPlayerAsteroidCollisions(localPlayer, [roid]);

      // Server applies damage; without a server player ID the client sends nothing
      expect(localShip.health).toBe(100);
      expect(networkManager.sendMessage).not.toHaveBeenCalled();
    });
  });
});
