import { expect, test } from 'vitest';
import { GAME } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { activateAbilityOnHost, tickAbilityHost } from '../../../src/entities/ship/shipAbilities';
import { SHIP_ABILITY } from '../../../src/entities/ship/shipKits';
import { scannedMaterial } from '../../../src/entities/ship/surveyScan';

test('Scout scan identifies nearby minerals then expires without changing motion', () => {
  const ship = new Ship({ kitId: 'scout' });
  ship.position = { x: 0, y: 0 };
  ship.velocity = { x: 1, y: 0.25 };
  const rock = {
    position: { x: SHIP_ABILITY.SCAN_RANGE, y: 0 },
    material: 'metal' as const,
    health: 75,
  };
  expect(scannedMaterial(ship, rock)).toBeUndefined();
  expect(activateAbilityOnHost(ship).activated).toBe(true);
  expect(SHIP_ABILITY.SCAN_FRAMES).toBe(2 * GAME.FPS);
  expect(SHIP_ABILITY.COOLDOWN_FRAMES.scout).toBe(20 * GAME.FPS);
  expect(ship.abilityActiveFrames).toBe(2 * GAME.FPS);
  expect(ship.abilityCooldownFrames).toBe(20 * GAME.FPS);
  expect(ship.velocity).toEqual({ x: 1, y: 0.25 });
  expect(scannedMaterial(ship, rock)).toBe('metal');
  expect(
    scannedMaterial(ship, { ...rock, position: { x: SHIP_ABILITY.SCAN_RANGE + 1, y: 0 } })
  ).toBeUndefined();
  expect(activateAbilityOnHost(ship).activated).toBe(false);
  for (let frame = 0; frame < SHIP_ABILITY.SCAN_FRAMES; frame++) {
    tickAbilityHost(ship);
  }
  expect(scannedMaterial(ship, rock)).toBeUndefined();
  expect(ship.abilityCooldownFrames).toBe(20 * GAME.FPS - 2 * GAME.FPS);
  expect(activateAbilityOnHost(ship).activated).toBe(false);
  while (ship.abilityCooldownFrames > 0) {
    tickAbilityHost(ship);
  }
  expect(activateAbilityOnHost(ship).activated).toBe(true);
});

test('Hauler and destroyed ships cannot classify asteroids using an active timer', () => {
  const rock = { position: { x: 0, y: 0 }, material: 'ice' as const, health: 75 };
  const ship = new Ship({ kitId: 'hauler' });
  ship.position = { x: 0, y: 0 };
  ship.abilityActiveFrames = SHIP_ABILITY.SCAN_FRAMES;
  expect(scannedMaterial(ship, rock)).toBeUndefined();
  ship.kitId = 'scout';
  ship.exploding = true;
  expect(scannedMaterial(ship, rock)).toBeUndefined();
  ship.exploding = false;
  expect(scannedMaterial(ship, { ...rock, health: 0 })).toBeUndefined();
});
