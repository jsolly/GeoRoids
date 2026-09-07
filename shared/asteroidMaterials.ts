import type { AsteroidMaterial } from '../shared-types';

/** Neutral minerals retain the same ownership-independent asteroid ink. */
export const ASTEROID_MATERIALS: readonly AsteroidMaterial[] = ['ice', 'metal', 'rubble'];

/** Runtime guard for JSON snapshots; TypeScript types do not validate the wire. */
export function isAsteroidMaterial(value: unknown): value is AsteroidMaterial {
  return typeof value === 'string' && ASTEROID_MATERIALS.includes(value as AsteroidMaterial);
}

export const MATERIAL_OUTLINES: Record<AsteroidMaterial, readonly number[]> = {
  ice: [1, 0.76, 1.08, 0.84, 1, 0.72],
  metal: [0.94, 1, 0.9, 0.97, 0.93, 1, 0.9, 0.98],
  rubble: [1, 0.58, 0.86, 0.72, 1.1, 0.64, 0.95, 0.56, 1.02, 0.74, 0.88, 0.62],
};

export function asteroidMaterialAt(slot: number): AsteroidMaterial {
  return ASTEROID_MATERIALS[slot % ASTEROID_MATERIALS.length] ?? 'ice';
}

export function asteroidShardMass(material?: AsteroidMaterial): number {
  return material === 'metal' ? 0.75 : 0.25;
}
