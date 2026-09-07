import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SATELLITE_PICKUP } from '../../../src/constants';
import { SatellitePickup } from '../../../src/entities/satellitePickup/SatellitePickup';
import { SatellitePickupManager } from '../../../src/entities/satellitePickup/SatellitePickupManager';
import { Ship } from '../../../src/entities/ship/Ship';
import { NetworkManager } from '../../../src/network/networkManager';
import { CollisionManager } from '../../../src/physics/collision/CollisionManager';
import { checkShipCollision } from '../../../src/physics/collision/collisionDetection';

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

function makePickup(overrides: Partial<ConstructorParameters<typeof SatellitePickup>[0]> = {}) {
  return new SatellitePickup({
    id: 'server-pickup-test',
    name: 'Echo',
    typeId: 'echo',
    assetKey: 'pickup/echo',
    position: { x: 400, y: 300 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    radius: SATELLITE_PICKUP.SIZE / 2,
    color: '#FBBF24',
    state: 'loose',
    ownerId: null,
    shieldFramesRemaining: 0,
    ...overrides,
  });
}

describe('satellite pickup collection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SatellitePickupManager.getInstance().clear();
  });

  test('overlapping a loose pickup reports satellitePickupCollected once', () => {
    const ship = new Ship();
    ship.position = { x: 400, y: 300 };
    ship.health = 100;
    const pickup = makePickup();

    CollisionManager.getInstance().checkPlayerSatellitePickupCollisions(
      { ship, id: 'local-player-123', type: 'local' },
      [pickup]
    );
    CollisionManager.getInstance().checkPlayerSatellitePickupCollisions(
      { ship, id: 'local-player-123', type: 'local' },
      [pickup]
    );

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'satellitePickupCollected',
      data: {
        pickupId: 'server-pickup-test',
        playerId: 'local-player-123',
      },
    });
    expect(NetworkManager.getInstance()).toBeTruthy();
  });

  test('orbiting pickups and dead ships do not collect', () => {
    const ship = new Ship();
    ship.position = { x: 400, y: 300 };
    ship.health = 0;
    CollisionManager.getInstance().checkPlayerSatellitePickupCollisions(
      { ship, id: 'local-player-123', type: 'local' },
      [makePickup()]
    );
    expect(mockSendMessage).not.toHaveBeenCalled();

    ship.health = 100;
    CollisionManager.getInstance().checkPlayerSatellitePickupCollisions(
      { ship, id: 'local-player-123', type: 'local' },
      [makePickup({ state: 'orbiting', ownerId: 'other' })]
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('a protected living pilot can collect a second loose communications satellite', () => {
    const ship = new Ship();
    ship.position = { x: 400, y: 300 };
    ship.health = 100;
    ship.spawnProtectionTimer = 180;
    CollisionManager.getInstance().checkPlayerSatellitePickupCollisions(
      { ship, id: 'local-player-123', type: 'local' },
      [makePickup({ id: 'second-pickup', name: 'Relay', typeId: 'relay', assetKey: 'pickup/relay' })]
    );
    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'satellitePickupCollected',
      data: { pickupId: 'second-pickup', playerId: 'local-player-123' },
    });
  });

  test('a ship overlapping a pickup hull collides', () => {
    expect(
      checkShipCollision({ x: 10, y: 0 }, 15, { x: 0, y: 0 }, SATELLITE_PICKUP.SIZE / 2)
    ).toBe(true);
  });
});
