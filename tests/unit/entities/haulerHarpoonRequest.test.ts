import { afterEach, expect, test, vi } from 'vitest';
import { publishHarpoonField } from '../../../src/entities/ship/harpoonField';
import { Ship } from '../../../src/entities/ship/Ship';
import { GameServerWorld } from '../scenarios/support/gameServerWorld';

const mockSendMessage = vi.fn<(message: Record<string, unknown>) => boolean>(() => true);
vi.mock('../../../src/network/networkManager', () => ({
  NetworkManager: {
    getInstance: vi.fn(() => ({
      isConnected: true,
      getLocalPlayerId: () => 'alice',
      sendMessage: mockSendMessage,
    })),
  },
}));
afterEach(() => {
  mockSendMessage.mockReset();
  mockSendMessage.mockReturnValue(true);
  publishHarpoonField([]);
});

test('a Hauler asks the server even when its visible field has no eligible target', () => {
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  expect(ship.activateAbility()).toBe(true);
  expect(mockSendMessage).toHaveBeenCalledWith({
    type: 'useAbility',
    id: 'alice',
    data: { kitId: 'hauler', abilityId: 'harpoon' },
  });
  expect(ship.abilityCooldownFrames).toBe(0);
  expect(ship.harpoonTargetId).toBeNull();
});

test('a rejected send cannot invent a local attachment or start its cooldown', () => {
  publishHarpoonField([{ id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }]);
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  mockSendMessage.mockReturnValue(false);
  expect(ship.activateAbility()).toBe(false);
  expect(ship.harpoonTargetId).toBeNull();
  expect(ship.abilityCooldownFrames).toBe(0);
});

test('two rapid presses reach the server in order without a predicted cooldown dropping release', () => {
  const world = new GameServerWorld();
  try {
    const pilot = world.joinWithId('alice', 'Alice', { x: 0, y: 0 }, { kitId: 'hauler' });
    world.clearAsteroids();
    world.engine.addAsteroid({
      id: 'tow-rock',
      position: { x: 80, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 20,
      jaggedness: 0.4,
      rotation: 0,
      angularVelocity: 0,
      health: 75,
      maxHealth: 75,
      vertices: 8,
      offsets: [1, 1, 1, 1, 1, 1, 1, 1],
    });
    const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
    expect(ship.activateAbility()).toBe(true);
    expect(ship.activateAbility()).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const requests = mockSendMessage.mock.calls.map((call) => call[0]);
    const first = requests[0];
    const second = requests[1];
    if (!first || !second) {
      throw new Error('Missing ability commands');
    }
    world.send(pilot, first);
    expect(world.entity(pilot).harpoonTargetId).toBe('tow-rock');
    expect(world.entity(pilot).abilityCooldownFrames).toBe(180);
    world.send(pilot, second);
    expect(world.entity(pilot).harpoonTargetId).toBeNull();
    expect(ship.harpoonTargetId).toBeNull();
  } finally {
    world.dispose();
  }
});

test('an acknowledged Hauler tow releases during cooldown while a detached hull stays cooling', () => {
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  ship.harpoonTargetId = 'acknowledged-rock';
  ship.abilityCooldownFrames = 170;
  expect(ship.activateAbility()).toBe(true);
  expect(mockSendMessage).toHaveBeenCalledOnce();
  // Keep the visible result authoritative until its release is confirmed.
  expect(ship.harpoonTargetId).toBe('acknowledged-rock');
  ship.harpoonTargetId = null;
  expect(ship.activateAbility()).toBe(false);
  expect(mockSendMessage).toHaveBeenCalledOnce();
});

test('Surveyor does not send a failed ability request', () => {
  const ship = new Ship({ kitId: 'surveyor', isLocalPlayer: true });
  ship.abilityCooldownFrames = 40;
  expect(ship.activateAbility()).toBe(false);
  expect(mockSendMessage).not.toHaveBeenCalled();
});
