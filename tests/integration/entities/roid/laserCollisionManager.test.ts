import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Laser } from '../../../../src/entities/laser/Laser';
import type { Roid } from '../../../../src/entities/roid/Roid';
import type { Ship } from '../../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../../src/physics/collision/CollisionManager';

// Mock NetworkManager for integration testing
const mockSendMessage = vi.fn();
const mockUpdatePlayerState = vi.fn();
const mockGetPlayer = vi.fn();
const mockGetLocalPlayerId = vi.fn();
const mockGetAllPlayers = vi.fn(() => []);

vi.mock('../../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      sendMessage: mockSendMessage,
      updatePlayerState: mockUpdatePlayerState,
      getPlayer: mockGetPlayer,
      getLocalPlayerId: mockGetLocalPlayerId,
      getAllPlayers: mockGetAllPlayers,
    })),
  },
}));

// Mock logger
vi.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('Laser Collision Manager Integration', () => {
  let collisionManager: CollisionManager;
  let mockLaser: Laser;
  let mockAsteroid: Roid;
  let mockBot: Ship;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Get collision manager instance
    collisionManager = CollisionManager.getInstance();

    // Create mock laser
    mockLaser = {
      position: { x: 100, y: 100 },
      velocity: { x: 5, y: 0 },
      distTraveled: 0,
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
      move: vi.fn(),
      isExpired: vi.fn().mockReturnValue(false),
      shouldBeRemoved: vi.fn().mockReturnValue(false),
      playLaserSound: vi.fn(),
    } as unknown as Laser;

    // Create mock asteroid
    mockAsteroid = {
      position: { x: 100, y: 100 },
      r: 20,
      id: 'test-asteroid-1',
      pendingDestruction: false,
      pendingUntilMs: 0,
    } as Roid;

    // Create mock bot
    mockBot = {
      position: { x: 100, y: 100 },
      r: 15,
      id: 'server-bot-1',
      health: 100,
      exploding: false,
    } as Ship;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Laser vs Asteroid Collisions', () => {
    test('handles laser hitting asteroid', () => {
      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const bots: Ship[] = [];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Verify laser explosion methods were called
      expect(mockLaser.updateExplodeTime).toHaveBeenCalled();
      expect(mockLaser.playHitSound).toHaveBeenCalled();

      // Dummy origin update used to yank the shooter; hits only report the rock.
      expect(mockUpdatePlayerState).not.toHaveBeenCalled();
      expect(mockAsteroid.pendingDestruction).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'asteroidDestroyed',
        data: {
          asteroidId: 'test-asteroid-1',
          playerId: localPlayerId,
          points: 50, // Medium asteroid points (radius 20)
          cause: 'laser',
          laserPosition: { x: 100, y: 100 },
        },
      });
    });

    test('does not double-apply the same laser-asteroid hit', () => {
      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(lasers, asteroids, [], localPlayerId);
      mockLaser.hasExploded = true;
      collisionManager.checkLaserCollisions(lasers, asteroids, [], localPlayerId);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('skips asteroids already pending server confirmation', () => {
      mockAsteroid.pendingDestruction = true;
      mockAsteroid.pendingUntilMs = Date.now() + 800;
      const secondLaser = {
        ...mockLaser,
        hasExploded: false,
        updateExplodeTime: vi.fn(),
        playHitSound: vi.fn(),
      } as unknown as Laser;

      collisionManager.checkLaserCollisions([secondLaser], [mockAsteroid], [], 'test-player');

      expect(secondLaser.updateExplodeTime).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('bot lasers report through the same asteroidDestroyed path', () => {
      collisionManager.checkLaserCollisions([mockLaser], [mockAsteroid], [], 'server-bot-1');

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'asteroidDestroyed',
        data: {
          asteroidId: 'test-asteroid-1',
          playerId: 'server-bot-1',
          points: 50,
          cause: 'laser',
          laserPosition: { x: 100, y: 100 },
        },
      });
    });

    test('handles laser hitting small asteroid', () => {
      mockAsteroid.r = 15; // Small asteroid
      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const bots: Ship[] = [];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'asteroidDestroyed',
        data: {
          asteroidId: 'test-asteroid-1',
          playerId: localPlayerId,
          points: 100, // Small asteroid points
          cause: 'laser',
          laserPosition: { x: 100, y: 100 },
        },
      });
    });

    test('handles laser hitting large asteroid', () => {
      mockAsteroid.r = 40; // Large asteroid
      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const bots: Ship[] = [];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'asteroidDestroyed',
        data: {
          asteroidId: 'test-asteroid-1',
          playerId: localPlayerId,
          points: 20, // Large asteroid points
          cause: 'laser',
          laserPosition: { x: 100, y: 100 },
        },
      });
    });

    test('skips already exploded lasers', () => {
      mockLaser.hasExploded = true;
      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const bots: Ship[] = [];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Verify no collision handling occurred
      expect(mockLaser.updateExplodeTime).not.toHaveBeenCalled();
      expect(mockLaser.playHitSound).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Laser vs Bot Collisions', () => {
    test('handles laser hitting bot', () => {
      const lasers = [mockLaser];
      const asteroids: Roid[] = [];
      const bots = [mockBot];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Verify laser explosion methods were called
      expect(mockLaser.updateExplodeTime).toHaveBeenCalled();
      expect(mockLaser.playHitSound).toHaveBeenCalled();

      // Verify bot damage message was sent
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'botDamage',
        data: {
          botId: 'server-bot-1',
          attackerId: localPlayerId,
          damage: 25, // Standard laser damage
        },
      });
    });

    test('skips exploding bots', () => {
      mockBot.exploding = true;
      const lasers = [mockLaser];
      const asteroids: Roid[] = [];
      const bots = [mockBot];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Verify no collision handling occurred
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('skips bots with no health', () => {
      mockBot.health = 0;
      const lasers = [mockLaser];
      const asteroids: Roid[] = [];
      const bots = [mockBot];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Verify no collision handling occurred
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('Laser Priority (Asteroid vs Bot)', () => {
    test('laser hits asteroid before bot when both are present', () => {
      // Position bot at a different location so laser doesn't hit both
      mockBot.position = { x: 200, y: 200 };

      const lasers = [mockLaser];
      const asteroids = [mockAsteroid];
      const bots = [mockBot];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Should send asteroid destroyed message, not bot damage
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'asteroidDestroyed',
        data: {
          asteroidId: 'test-asteroid-1',
          playerId: localPlayerId,
          points: 50, // Medium asteroid points (radius 20)
          cause: 'laser',
          laserPosition: { x: 100, y: 100 },
        },
      });

      // Should not send bot damage message since laser hit asteroid first
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    test('laser hits bot when no asteroids are present', () => {
      const lasers = [mockLaser];
      const asteroids: Roid[] = [];
      const bots = [mockBot];
      const localPlayerId = 'test-player';

      collisionManager.checkLaserCollisions(
        lasers,
        asteroids,
        bots.map((ship) => ({ ship, id: ship.id, type: 'bot' as const })),
        localPlayerId
      );

      // Should send bot damage message
      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'botDamage',
        data: {
          botId: 'server-bot-1',
          attackerId: localPlayerId,
          damage: 25,
        },
      });
    });
  });
});
