import { type BeltSlotState, readBeltState } from '../../shared/asteroidBelt';
import { validCivicModules } from '../../shared/furnaces';
import { releaseField } from '../../shared/releaseId';
import type { CivicModule } from '../../shared-types';

export interface SavedWorld {
  asteroidBelt?: BeltSlotState[];
  /** Furnaces a Scout paid for. Absent on older rows. */
  civicModules?: CivicModule[];
  seed: number;
  startedAt: number;
  generation: number;
  writtenReleaseId?: string;
}

/** Parse world metadata without rewriting unknown legacy fields. */
export function readSavedWorld(value: unknown): SavedWorld {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('seed' in value) ||
    !('startedAt' in value) ||
    typeof value.seed !== 'number' ||
    !Number.isFinite(value.seed) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt)
  ) {
    throw new Error('Saved world is invalid; refusing to replace player progress');
  }
  const asteroidBelt = readBeltState('asteroidBelt' in value ? value.asteroidBelt : undefined);
  return {
    seed: value.seed,
    ...(asteroidBelt ? { asteroidBelt } : {}),
    civicModules: readCivicModules(value),
    startedAt: value.startedAt,
    generation:
      'generation' in value &&
      typeof value.generation === 'number' &&
      Number.isSafeInteger(value.generation)
        ? value.generation
        : 0,
    ...releaseField(
      'writtenReleaseId',
      'writtenReleaseId' in value ? value.writtenReleaseId : undefined
    ),
  };
}

function readCivicModules(value: object): CivicModule[] {
  if ('civicModules' in value) {
    if (!validCivicModules(value.civicModules)) {
      throw new Error('Saved furnaces are invalid; refusing to replace player progress');
    }
    return value.civicModules;
  }
  return [];
}
