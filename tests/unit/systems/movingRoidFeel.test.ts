import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Laser } from '../../../src/entities/laser/Laser';
import { Roid } from '../../../src/entities/roid/Roid';
import { applyShipImpactFlash, tickShipImpactFlash } from '../../../src/entities/ship/shipUtils';
import {
  isAsteroidPending,
  lockAsteroidPending,
  shouldReportLaserAsteroidHit,
} from '../../../src/physics/collision/asteroidHitFeel';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';
import { checkLaserAsteroidCollisionSwept } from '../../../src/physics/collision/collisionDetection';

const mockSendMessage = vi.fn();
const mockUpdatePlayerState = vi.fn();
const mockGetLocalPlayerId = vi.fn(() => 'local-player-123');

vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      isConnected: true,
      getLocalPlayerId: mockGetLocalPlayerId,
      sendMessage: mockSendMessage,
      updatePlayerState: mockUpdatePlayerState,
    })),
  },
}));

vi.mock('../../../src/audio/gameSounds', () => ({
  playHitSound: vi.fn(),
  playLaserSound: vi.fn(),
  getHitSound: vi.fn(),
  getLaserSound: vi.fn(),
}));

vi.mock('../../../src/audio/spatialAudio', () => ({
  playWorldSound: vi.fn(),
}));

vi.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('moving-roid hit feel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a swept laser hits a moving roid that a point sample would tunnel through', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 12, y: 0 };
    const asteroid = { x: 6, y: 8 };
    expect(checkLaserAsteroidCollisionSwept(from, to, asteroid, 7)).toBe(true);
    expect(checkLaserAsteroidCollisionSwept(from, to, { x: 6, y: 40 }, 7)).toBe(false);
  });

  test('pending lock expires so a rejected report does not hide the rock forever', () => {
    const roid = { pendingDestruction: false, pendingUntilMs: 0 };
    lockAsteroidPending(roid, 1_000);
    expect(isAsteroidPending(roid, 1_100)).toBe(true);
    expect(isAsteroidPending(roid, 1_000 + 801)).toBe(false);
    expect(roid.pendingDestruction).toBe(false);
  });

  test('only the firing client reports a remote-human shot', () => {
    expect(shouldReportLaserAsteroidHit('local')).toBe(true);
    expect(shouldReportLaserAsteroidHit('bot')).toBe(true);
    expect(shouldReportLaserAsteroidHit('remote')).toBe(false);
  });

  test('a second laser on the same roid does not re-report while pending', () => {
    const collisionManager = CollisionManager.getInstance();
    const asteroid = new Roid({ x: 100, y: 100 }, 20);
    asteroid.id = 'roid-1';
    const first = new Laser({ x: 100, y: 100 }, { x: 5, y: 0 }, 0, 0, false);
    const second = new Laser({ x: 100, y: 100 }, { x: 5, y: 0 }, 0, 0, false);

    collisionManager.checkLaserCollisions([first, second], [asteroid], [], 'local-player-123');

    expect(mockUpdatePlayerState).not.toHaveBeenCalled();
    expect(asteroid.pendingDestruction).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect([first.hasExploded, second.hasExploded].filter(Boolean)).toHaveLength(1);
  });

  test('spectator lasers pop the bolt without sending asteroidDestroyed', () => {
    const collisionManager = CollisionManager.getInstance();
    const asteroid = new Roid({ x: 50, y: 50 }, 20);
    asteroid.id = 'roid-2';
    const laser = new Laser({ x: 50, y: 50 }, { x: 5, y: 0 }, 0, 0, false);

    collisionManager.checkLaserCollisions([laser], [asteroid], [], 'remote-9', {
      reportAsteroidHits: false,
    });

    expect(laser.hasExploded).toBe(true);
    expect(asteroid.pendingDestruction).toBe(true);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('impact flash ticks down on the shared player/bot path', () => {
    const ship = { impactFlashFrames: 0 };
    applyShipImpactFlash(ship);
    expect(ship.impactFlashFrames).toBeGreaterThan(0);
    const start = ship.impactFlashFrames;
    tickShipImpactFlash(ship);
    expect(ship.impactFlashFrames).toBe(start - 1);
  });
});
