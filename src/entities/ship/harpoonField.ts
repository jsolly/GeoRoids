import type { AbilityBody } from './shipAbilities';

let field: readonly AbilityBody[] = [];
let holdEmptyField = false;
let fieldSource: (() => readonly AbilityBody[]) | null = null;

/** KeyE can refresh the live asteroid field before the next render tick. */
export function bindHarpoonFieldSource(source: (() => readonly AbilityBody[]) | null): void {
  fieldSource = source;
}

export function syncHarpoonFieldFromPlay(): readonly AbilityBody[] {
  if (fieldSource) {
    publishHarpoonField(fieldSource());
  }
  return field;
}

/** Retain visible cargo while a disconnected client waits for its next snapshot. */
export function setHoldEmptyHarpoonField(hold: boolean): void {
  holdEmptyField = hold;
}

export function publishHarpoonField(asteroids: readonly AbilityBody[]): void {
  if (asteroids.length === 0 && holdEmptyField) {
    return;
  }
  if (asteroids.length > 0) {
    holdEmptyField = false;
  }
  field = asteroids;
}

export function getHarpoonField(): readonly AbilityBody[] {
  return field;
}

export function findHarpoonFieldBody(id: string | null | undefined): AbilityBody | undefined {
  return field.find((asteroid) => asteroid.id === id);
}
