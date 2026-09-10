import type { LootData, Position } from '../shared-types';
import { FUEL } from '../src/constants';

/** Shared tank shape for player and bot ships (client Ship + server GameEntity). */
export interface FuelTank {
  fuel: number;
  maxFuel: number;
}

export function createFuelTank(start: number = FUEL.START, max: number = FUEL.MAX): FuelTank {
  return {
    fuel: Math.min(max, Math.max(0, start)),
    maxFuel: max,
  };
}

export function ensureFuelTank(target: Partial<FuelTank>): FuelTank {
  if (target.maxFuel === undefined || !Number.isFinite(target.maxFuel)) {
    target.maxFuel = FUEL.MAX;
  }
  if (target.fuel === undefined || !Number.isFinite(target.fuel)) {
    target.fuel = FUEL.START;
  }
  target.fuel = Math.max(0, Math.min(target.maxFuel, target.fuel));
  return target as FuelTank;
}

export function shouldReleaseFuel(asteroidSize: number): boolean {
  return asteroidSize >= FUEL.MIN_ROID_SIZE_TO_DROP;
}

export function isFuelLoot(drop: Pick<LootData, 'kind'>): boolean {
  return drop.kind === 'fuel';
}

function calculateFuelAfterPickup(currentFuel: number, amount: number, maxFuel: number): number {
  return Math.min(maxFuel, Math.max(0, currentFuel + amount));
}

function calculateFuelAfterSpend(currentFuel: number, amount: number): number {
  return Math.max(0, currentFuel - amount);
}

export function canAffordFuelCost(currentFuel: number, cost: number): boolean {
  return currentFuel >= cost;
}

export function applyFuelPickup(tank: FuelTank, amount: number): number {
  tank.fuel = calculateFuelAfterPickup(tank.fuel, amount, tank.maxFuel);
  return tank.fuel;
}

export function trySpendEmpFuel(tank: FuelTank, cost: number = FUEL.EMP_COST): boolean {
  if (!canAffordFuelCost(tank.fuel, cost)) {
    return false;
  }
  tank.fuel = calculateFuelAfterSpend(tank.fuel, cost);
  return true;
}

export function applyFuelSnapshot(
  tank: FuelTank & { lastLocalFuelWriteMs?: number },
  data: { fuel?: number; maxFuel?: number },
  holdMs = 400
): void {
  if (typeof data.maxFuel === 'number' && Number.isFinite(data.maxFuel)) {
    tank.maxFuel = Math.max(1, data.maxFuel);
  }
  if (typeof data.fuel !== 'number' || !Number.isFinite(data.fuel)) {
    return;
  }
  const recentlyWrote =
    tank.lastLocalFuelWriteMs !== undefined && Date.now() - tank.lastLocalFuelWriteMs < holdMs;
  if (!recentlyWrote || data.fuel === tank.fuel) {
    tank.fuel = Math.max(0, Math.min(tank.maxFuel, data.fuel));
  }
}

export function createFuelLootData(
  id: string,
  position: Position,
  amount: number = FUEL.DROP_AMOUNT
): LootData {
  return {
    id,
    position: { x: position.x, y: position.y },
    mass: 0,
    radius: FUEL.DROP_RADIUS,
    kind: 'fuel',
    fuel: amount,
  };
}
