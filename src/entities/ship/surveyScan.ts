import type { AsteroidMaterial, Position, ShipKitId } from '../../../shared-types';
import { SHIP_ABILITY } from './shipKits';

type Scanner = {
  kitId: ShipKitId;
  position: Position;
  abilityActiveFrames: number;
  health: number;
  exploding: boolean;
};

function isActiveScanner(scanner: Scanner): boolean {
  return (
    scanner.kitId === 'scout' &&
    scanner.abilityActiveFrames > 0 &&
    !scanner.exploding &&
    scanner.health > 0
  );
}

/** Active scanners share their classification, centered on each Scout. */
export function activeScanners(viewer: Scanner, others: readonly Scanner[]): Scanner[] {
  return [viewer, ...others].filter((scanner) => isActiveScanner(scanner));
}

export function scannedMaterial(
  scanner: Scanner,
  asteroid: { position: Position; material?: AsteroidMaterial; health: number }
): AsteroidMaterial | undefined {
  if (!isActiveScanner(scanner) || asteroid.health <= 0) {
    return undefined;
  }
  const dx = asteroid.position.x - scanner.position.x;
  const dy = asteroid.position.y - scanner.position.y;
  return dx * dx + dy * dy <= SHIP_ABILITY.SCAN_RANGE ** 2 ? asteroid.material : undefined;
}
