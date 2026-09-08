import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Laser } from '../../../src/entities/laser/Laser';
import type { Ship } from '../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';

const mockSendMessage = vi.fn();

vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      sendMessage: mockSendMessage,
      updatePlayerState: vi.fn(),
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

describe('lasers pass through teammates', () => {
  let collisionManager: CollisionManager;
  let laser: Laser;
  let targetShip: Ship;

  beforeEach(() => {
    vi.clearAllMocks();
    collisionManager = CollisionManager.getInstance();
    laser = {
      position: { x: 100, y: 100 },
      velocity: { x: 5, y: 0 },
      distTraveled: 0,
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
    } as unknown as Laser;
    targetShip = {
      position: { x: 100, y: 100 },
      r: 15,
      id: 'remote-1',
      health: 100,
      exploding: false,
      blinkCount: 0,
    } as Ship;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('same-faction laser does not report damage', () => {
    collisionManager.checkLaserCollisions(
      [laser],
      [],
      [{ ship: targetShip, id: 'remote-1', type: 'remote', faction: 'ion' }],
      'local-1',
      { attackerFaction: 'ion' }
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(laser.updateExplodeTime).not.toHaveBeenCalled();
  });

  test('opposite-faction laser still reports damage', () => {
    collisionManager.checkLaserCollisions(
      [laser],
      [],
      [{ ship: targetShip, id: 'remote-1', type: 'remote', faction: 'ember' }],
      'local-1',
      { attackerFaction: 'ion' }
    );
    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'laserDamage',
      data: {
        targetPlayerId: 'remote-1',
        attackerId: 'local-1',
        damage: 25,
      },
    });
  });
});
