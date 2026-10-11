import {
  type AbilityBody,
  type AbilityHost,
  clearHaulerLatch,
} from '../../../shared/shipAbilities';
import type { Position, UtilityFlight } from '../../../shared-types';

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
  return getHarpoonField();
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
  return getHarpoonField().find((body) => body.id === id);
}

interface HarpoonLatchSnapshot {
  harpoonTargetId?: string | null;
  harpoonLatchPos?: Position;
  utilityFlight?: UtilityFlight | null;
}

function rememberLatchPos(
  host: Pick<AbilityHost, 'harpoonTargetId' | 'harpoonLatchPos'>,
  snapshot?: HarpoonLatchSnapshot
): void {
  if (snapshot?.harpoonLatchPos) {
    host.harpoonLatchPos = { x: snapshot.harpoonLatchPos.x, y: snapshot.harpoonLatchPos.y };
    return;
  }
  const body = findHarpoonFieldBody(host.harpoonTargetId);
  if (body) {
    host.harpoonLatchPos = { x: body.position.x, y: body.position.y };
  }
}

/** Explicit null detaches the tow on every client. */
export function applySharedHarpoonLatch(
  host: Pick<AbilityHost, 'kitId' | 'harpoonTargetId' | 'harpoonLatchPos'>,
  snapshot: HarpoonLatchSnapshot
): void {
  if (host.kitId !== 'hauler') {
    clearHaulerLatch(host);
    return;
  }
  if (snapshot.harpoonTargetId === undefined) {
    return;
  }
  host.harpoonTargetId = snapshot.harpoonTargetId;
  if (host.harpoonTargetId === null) {
    delete host.harpoonLatchPos;
  } else {
    rememberLatchPos(host, snapshot);
  }
}
