import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Laser } from '../../../src/entities/laser/Laser';
import { Ship } from '../../../src/entities/ship/Ship';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';

const mockSendMessage = vi.fn();
const mockUpdatePlayerState = vi.fn();

vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      sendMessage: mockSendMessage,
      updatePlayerState: mockUpdatePlayerState,
      getPlayer: vi.fn(),
      getAllPlayers: vi.fn(() => []),
      getLocalPlayerId: vi.fn(),
    })),
  },
}));

vi.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('incoming lasers use the shared hull path', () => {
  let collisionManager: CollisionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    collisionManager = CollisionManager.getInstance();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('a bot laser that overlaps the local ship reports laserDamage', () => {
    const laser = {
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

    const localShip = new Ship();
    localShip.position = { x: 100, y: 100 };
    localShip.health = 100;
    localShip.exploding = false;
    localShip.blinkCount = 0;

    collisionManager.checkLaserCollisions(
      [laser],
      [],
      [{ ship: localShip, id: 'human-pilot', type: 'local', faction: 'ion' }],
      'server-bot-0',
      { attackerFaction: 'ember' }
    );

    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'laserDamage',
      data: {
        targetPlayerId: 'human-pilot',
        attackerId: 'server-bot-0',
        damage: 25,
      },
    });
  });

  test('spawn-protected local ships do not report incoming laserDamage', () => {
    const laser = {
      position: { x: 100, y: 100 },
      velocity: { x: 5, y: 0 },
      distTraveled: 0,
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
    } as unknown as Laser;

    const localShip = new Ship();
    localShip.position = { x: 100, y: 100 };
    localShip.health = 100;
    localShip.blinkCount = 4;

    collisionManager.checkLaserCollisions(
      [laser],
      [],
      [{ ship: localShip, id: 'human-pilot', type: 'local' }],
      'server-bot-0'
    );

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('enemy lasers flash an active F shield while allied lasers stay quiet', () => {
    const enemyLaser = {
      position: { x: 100, y: 100 },
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
    } as unknown as Laser;
    const allyLaser = {
      position: { x: 100, y: 100 },
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
    } as unknown as Laser;
    const enemyTarget = new Ship();
    enemyTarget.position = { x: 100, y: 100 };
    enemyTarget.shieldActive = true;
    enemyTarget.shieldTime = 30;
    const allyTarget = new Ship();
    allyTarget.position = { x: 100, y: 100 };
    allyTarget.shieldActive = true;
    allyTarget.shieldTime = 30;

    collisionManager.explodeIncomingLasersOnShieldedShip([enemyLaser], enemyTarget, false);
    collisionManager.explodeIncomingLasersOnShieldedShip([allyLaser], allyTarget, true);

    expect(enemyLaser.updateExplodeTime).toHaveBeenCalledTimes(1);
    expect(enemyTarget.shieldFlashTime).toBeGreaterThan(0);
    expect(allyLaser.updateExplodeTime).not.toHaveBeenCalled();
    expect(allyTarget.shieldFlashTime).toBe(0);
  });

  test('an enemy laser also flashes a Warden E shield without changing F state', () => {
    const laser = {
      position: { x: 100, y: 100 },
      explodeTime: 0,
      hasExploded: false,
      updateExplodeTime: vi.fn(),
      playHitSound: vi.fn(),
    } as unknown as Laser;
    const warden = new Ship({ kitId: 'warden' });
    warden.position = { x: 100, y: 100 };
    expect(warden.activateAbility()).toBe(true);
    expect(warden.shieldTimer).toBeGreaterThan(0);
    expect(warden.shieldActive).toBe(false);

    collisionManager.explodeIncomingLasersOnShieldedShip([laser], warden, false);

    expect(laser.updateExplodeTime).toHaveBeenCalledTimes(1);
    expect(warden.shieldFlashTime).toBeGreaterThan(0);
    expect(warden.shieldTimer).toBeGreaterThan(0);
  });
});
