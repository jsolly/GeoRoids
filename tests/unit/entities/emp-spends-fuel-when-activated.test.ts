import { beforeEach, describe, expect, test } from 'vitest';
import { canAffordFuelCost, type FuelTank, trySpendEmpFuel } from '../../../shared/fuel';
import { FUEL } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';
import { type AbilityHost, activateAbilityOnHost } from '../../../src/entities/ship/shipAbilities';
import { applyShipKitToShip } from '../../../src/entities/ship/shipKits';

function host(kitId: AbilityHost['kitId'], fuel: number = FUEL.START): AbilityHost {
  return {
    kitId,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    angle: 0,
    exploding: false,
    health: 100,
    abilityCooldownFrames: 0,
    abilityActiveFrames: 0,
    shieldTimer: 0,
    harpoonTimer: 0,
    fuel,
    maxFuel: FUEL.MAX,
  };
}

describe('Quake abilities spend the shared fuel tank', () => {
  let ship: Ship;

  beforeEach(() => {
    ship = new Ship({ position: { x: 100, y: 100 } });
    ship.exploding = false;
  });

  test('player and bot ships start with the same tank', () => {
    const bot = new Ship({ position: { x: 0, y: 0 }, isBot: true });
    expect(ship.fuel).toBe(FUEL.START);
    expect(bot.fuel).toBe(FUEL.START);
    expect(ship.maxFuel).toBe(FUEL.MAX);
    expect(bot.maxFuel).toBe(FUEL.MAX);
  });

  test('Quake shock pulse spends fuel and pushes a nearby rock', () => {
    const quake = host('quake');
    const rock = { position: { x: 40, y: 0 }, velocity: { x: 0, y: 0 } };
    const result = activateAbilityOnHost(quake, { asteroids: [rock], entities: [] });

    expect(result.activated).toBe(true);
    expect(result.abilityId).toBe('shockPulse');
    expect(quake.fuel).toBe(FUEL.START - FUEL.EMP_COST);
    expect(rock.velocity.x).toBeGreaterThan(0);
  });

  test('Quake shock is refused when the tank is empty', () => {
    const quake = host('quake', 0);
    const result = activateAbilityOnHost(quake, { asteroids: [], entities: [] });
    expect(result.activated).toBe(false);
    expect(quake.fuel).toBe(0);
    expect(quake.abilityCooldownFrames).toBe(0);
  });

  test('Dart boost does not spend fuel', () => {
    const dart = host('dart');
    const result = activateAbilityOnHost(dart);
    expect(result.activated).toBe(true);
    expect(result.abilityId).toBe('boostDash');
    expect(dart.fuel).toBe(FUEL.START);
  });

  test('a live Quake ship spends fuel through activateAbility', () => {
    applyShipKitToShip(ship, 'quake');
    expect(ship.activateAbility()).toBe(true);
    expect(ship.fuel).toBe(FUEL.START - FUEL.EMP_COST);
  });

  test('shared spend helper is what player and bot tanks use', () => {
    const tank: FuelTank = { fuel: FUEL.START, maxFuel: FUEL.MAX };
    expect(canAffordFuelCost(tank.fuel, FUEL.EMP_COST)).toBe(true);
    expect(trySpendEmpFuel(tank)).toBe(true);
    expect(tank.fuel).toBe(FUEL.START - FUEL.EMP_COST);
    tank.fuel = 0;
    expect(trySpendEmpFuel(tank)).toBe(false);
  });
});
