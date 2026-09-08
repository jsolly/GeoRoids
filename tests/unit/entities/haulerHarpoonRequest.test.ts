import { afterEach, expect, test, vi } from 'vitest';
import { publishHarpoonField } from '../../../src/entities/ship/harpoonField';
import { Ship } from '../../../src/entities/ship/Ship';

const mockSendMessage = vi.fn();

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
  mockSendMessage.mockClear();
  publishHarpoonField([]);
});

test('local Hauler still asks the server when the local field has no target', () => {
  publishHarpoonField([]);
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  expect(ship.activateAbility()).toBe(false);
  expect(mockSendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'useAbility',
      id: 'alice',
      data: expect.objectContaining({ kitId: 'hauler', abilityId: 'harpoon' }),
    })
  );
  expect(ship.abilityCooldownFrames).toBe(0);
});

test('a missed Hauler E does not lock the next tap behind cooldown', () => {
  publishHarpoonField([]);
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  expect(ship.activateAbility()).toBe(false);
  publishHarpoonField([{ id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }]);
  expect(ship.activateAbility()).toBe(true);
  expect(ship.harpoonTargetId).toBe('rock-1');
  expect(ship.harpoonTimer).toBeGreaterThan(0);
});

test('local Hauler still sends useAbility after a local latch', () => {
  publishHarpoonField([{ id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 } }]);
  const ship = new Ship({ kitId: 'hauler', isLocalPlayer: true });
  expect(ship.activateAbility()).toBe(true);
  expect(mockSendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'useAbility',
      id: 'alice',
      data: expect.objectContaining({ kitId: 'hauler', abilityId: 'harpoon' }),
    })
  );
});

test('Dart does not send a failed ability request', () => {
  const ship = new Ship({ kitId: 'dart', isLocalPlayer: true });
  ship.abilityCooldownFrames = 40;
  expect(ship.activateAbility()).toBe(false);
  expect(mockSendMessage).not.toHaveBeenCalled();
});
