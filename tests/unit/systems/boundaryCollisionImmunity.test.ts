import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Ship } from '../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';

const mockSendMessage = vi.fn();
const mockGetLocalPlayerId = vi.fn(() => 'local-player-123');

vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      isConnected: true,
      getLocalPlayerId: mockGetLocalPlayerId,
      sendMessage: mockSendMessage,
    })),
  },
}));

vi.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/physics/collision/collisionDetection', () => ({
  checkBoundaryCollision: vi.fn(() => true),
}));

describe('Boundary collision immunity', () => {
  let collisionManager: CollisionManager;
  let ship: Ship;

  beforeEach(() => {
    vi.clearAllMocks();
    collisionManager = CollisionManager.getInstance();
    ship = new Ship({ isLocalPlayer: false });
    ship.health = 100;
    ship.blinkCount = 0;
    ship.exploding = false;
    ship.position = { x: 3200, y: 0 };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('sends boundary damage for a vulnerable ship', () => {
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123');
    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'collisionDamage',
      data: {
        targetPlayerId: 'local-player-123',
        attackerId: 'boundary',
        damage: 100,
      },
    });
    expect(ship.exploding).toBe(true);
    expect(ship.health).toBe(0);
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
  });

  test('does not send boundary damage while blinking', () => {
    ship.blinkCount = 12;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('does not send boundary damage while dead or exploding', () => {
    ship.health = 0;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123');
    expect(mockSendMessage).not.toHaveBeenCalled();

    ship.health = 100;
    ship.exploding = true;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
