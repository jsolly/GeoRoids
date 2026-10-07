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
    ship.health = 400;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123', 0);
    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'collisionDamage',
      data: {
        targetPlayerId: 'local-player-123',
        attackerId: 'boundary',
      },
    });
    expect(ship.exploding).toBe(true);
    expect(ship.health).toBe(0);
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
  });

  test('separate collision runtimes report damage through their own pilot connections', () => {
    const sendA = vi.fn(() => true);
    const sendB = vi.fn(() => true);
    const runtimeA = new CollisionManager({
      getLocalPlayerId: () => 'pilot-a',
      sendMessage: sendA,
    });
    const runtimeB = new CollisionManager({
      getLocalPlayerId: () => 'pilot-b',
      sendMessage: sendB,
    });
    const shipA = new Ship({ isLocalPlayer: false });
    const shipB = new Ship({ isLocalPlayer: false });
    for (const hull of [shipA, shipB]) {
      hull.health = 100;
      hull.blinkCount = 0;
      hull.exploding = false;
    }

    runtimeA.checkBoundaryCollisions([shipA], 'pilot-a', 0);
    expect(sendA).toHaveBeenCalledExactlyOnceWith({
      type: 'collisionDamage',
      data: { targetPlayerId: 'pilot-a', attackerId: 'boundary' },
    });
    expect(sendB).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(shipA.health).toBe(0);
    expect(shipA.exploding).toBe(true);
    expect(shipB.health).toBe(100);

    runtimeB.checkBoundaryCollisions([shipB], 'pilot-b', 0);
    expect(sendB).toHaveBeenCalledExactlyOnceWith({
      type: 'collisionDamage',
      data: { targetPlayerId: 'pilot-b', attackerId: 'boundary' },
    });
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(shipB.health).toBe(0);
    expect(shipB.exploding).toBe(true);
  });

  test('does not send boundary damage while blinking', () => {
    ship.blinkCount = 12;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123', 0);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('does not send boundary damage while a menu holds the ship', () => {
    ship.movementLocked = true;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123', 0);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('does not send boundary damage while dead or exploding', () => {
    ship.health = 0;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123', 0);
    expect(mockSendMessage).not.toHaveBeenCalled();

    ship.health = 100;
    ship.exploding = true;
    collisionManager.checkBoundaryCollisions([ship], 'local-player-123', 0);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

test('a cargo-protected wall contact flashes and reports the hit without predicting hull death', () => {
  const sendMessage = vi.fn();
  const manager = new CollisionManager({ getLocalPlayerId: () => 'cargo-pilot', sendMessage });
  const hull = new Ship({ isLocalPlayer: false });
  hull.health = 100;
  hull.blinkCount = 0;
  manager.checkBoundaryCollisions([hull], 'cargo-pilot', 400);
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(hull.health).toBe(100);
  expect(hull.exploding).toBe(false);
  expect(hull.impactFlashFrames).toBeGreaterThan(0);
});
