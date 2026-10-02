import { afterEach, expect, test, vi } from 'vitest';
import { civicLot } from '../../../shared/furnaces';
import { Ship } from '../../../src/entities/ship/Ship';
import { resetWorldExploration } from '../../../src/network/worldExploration';

afterEach(() => {
  resetWorldExploration();
});

test('a Scout sends an escape-furnace build during tool cooldown without resetting the tool timer', () => {
  const street = civicLot('street-1-0');
  if (!street) {
    throw new Error('Missing street lot');
  }
  resetWorldExploration();
  const sendAbility = vi.fn(() => true);
  const combatNetwork = {
    isConnected: true,
    sendShoot: () => undefined,
    sendAbility,
  };
  const ship = new Ship({ combatNetwork });
  ship.kitId = 'scout';
  ship.isLocalPlayer = true;
  ship.position = { ...street.position };
  ship.abilityCooldownFrames = 120;
  expect(ship.activateAbility()).toBe(true);
  expect(sendAbility).toHaveBeenCalledOnce();
  expect(ship.abilityCooldownFrames).toBe(120);
  ship.health = 0;
  expect(ship.activateAbility()).toBe(false);
  ship.health = 100;
  ship.position = { x: 20_000, y: 20_000 };
  expect(ship.activateAbility()).toBe(false);
});
