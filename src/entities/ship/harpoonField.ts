import { findNearestAsteroidImpact } from '../../../shared/asteroidReflection';
import type { Position, SoftFactionId, Velocity } from '../../../shared-types';

/** Asteroid or ship the Hauler harpoon can latch. Same shape on client and server. */
export interface HarpoonFieldBody {
  id: string;
  position: Position;
  velocity: Velocity;
  kind?: 'asteroid' | 'ship';
  factionId?: SoftFactionId;
  exploding?: boolean;
  health?: number;
  r?: number;
  size?: number;
  rotation?: number;
  vertices?: number;
  offsets?: number[];
  shieldTimer?: number;
  shieldActive?: boolean;
}

let field: readonly HarpoonFieldBody[] = [];
let fieldScale = 1;
let fieldCanvas: { width: number; height: number } | undefined;
const lastKnown = new Map<string, HarpoonFieldBody>();
/** Keep the last live latch list across a WS flap empty publish. */
let holdEmptyField = false;

export type HarpoonFieldSnapshot = {
  bodies: readonly HarpoonFieldBody[];
  playfieldScale?: number;
  canvas?: { width: number; height: number };
};

type HarpoonFieldSource = () => HarpoonFieldSnapshot | null | undefined;

let fieldSource: HarpoonFieldSource | null = null;

/** Game loop registers the live belt + ships so KeyE is not stuck on a stale publish. */
export function bindHarpoonFieldSource(source: HarpoonFieldSource | null): void {
  fieldSource = source;
}

/** Refresh the latch list from the playfield. Safe to call from KeyE outside the loop. */
export function syncHarpoonFieldFromPlay(): readonly HarpoonFieldBody[] {
  const snapshot = fieldSource?.();
  if (snapshot) {
    publishHarpoonField(snapshot.bodies, snapshot.playfieldScale ?? fieldScale, snapshot.canvas);
  }
  return field;
}

/** Mid-reconnect: an empty belt tick must not wipe rocks the pilot still sees. */
export function setHoldEmptyHarpoonField(hold: boolean): void {
  holdEmptyField = hold;
}

/** Playfield snapshot for local latch + tether VFX. Server uses its own lists. */
export function publishHarpoonField(
  bodies: readonly HarpoonFieldBody[],
  playfieldScale = 1,
  canvas?: { width: number; height: number }
): void {
  if (Number.isFinite(playfieldScale) && playfieldScale > 0) {
    fieldScale = playfieldScale;
  }
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    fieldCanvas = { width: canvas.width, height: canvas.height };
  }
  if (bodies.length === 0 && holdEmptyField && field.length > 0) {
    return;
  }
  const hasAuthoritativeAsteroids = bodies.some((body) => body.kind !== 'ship');
  if (holdEmptyField && !hasAuthoritativeAsteroids) {
    // A game-state tick can still contain remote ships while the authoritative
    // asteroid list is temporarily empty. Keep the warm rock list until a
    // snapshot with a live asteroid generation arrives.
    const heldAsteroids = field.filter((body) => body.kind !== 'ship');
    if (heldAsteroids.length > 0) {
      field = [...heldAsteroids, ...bodies];
      for (const body of bodies) {
        lastKnown.set(body.id, body);
      }
      return;
    }
  }
  if (hasAuthoritativeAsteroids) {
    holdEmptyField = false;
    // A non-empty authoritative snapshot ends the reconnect grace period.
    // Retain only bodies from that live field so a stale latch cannot resolve
    // forever after the server has replaced the asteroid generation.
    const liveIds = new Set(bodies.map((body) => body.id));
    for (const knownId of lastKnown.keys()) {
      if (!liveIds.has(knownId)) {
        lastKnown.delete(knownId);
      }
    }
  }
  field = bodies;
  for (const body of bodies) {
    lastKnown.set(body.id, body);
  }
}

export function getHarpoonField(): readonly HarpoonFieldBody[] {
  return field;
}

export function getHarpoonFieldScale(): number {
  return fieldScale;
}

export function getHarpoonFieldCanvas(): { width: number; height: number } | undefined {
  return fieldCanvas;
}

function idsMatch(left: string, right: string): boolean {
  return left === right || left.endsWith(right) || right.endsWith(left);
}

export function findHarpoonFieldBody(id: string | undefined): HarpoonFieldBody | undefined {
  if (!id) {
    return undefined;
  }
  const exact = field.find((body) => body.id === id);
  if (exact) {
    return exact;
  }
  const loose = field.find((body) => idsMatch(body.id, id));
  if (loose) {
    return loose;
  }
  for (const [knownId, body] of lastKnown) {
    if (idsMatch(knownId, id)) {
      return body;
    }
  }
  return undefined;
}

/** Render-facing Roid attributes; converters retain the actual moving contour. */
interface HarpoonRock {
  id?: string;
  position: Position;
  velocity: Velocity;
  r?: number;
  angle?: number;
  vertices?: number;
  offsets?: number[];
  health?: number;
  exploding?: boolean;
}

/** Polygon exit toward another rock, using the laser/preview collision contour.
 * Older radius-only field rows retain their circular outline approximation.
 */
export function harpoonSurfaceToward(
  body: HarpoonFieldBody,
  toward: Position
): Position | undefined {
  const radius = body.r ?? body.size;
  if (radius === undefined || !Number.isFinite(radius) || radius <= 0) {
    return undefined;
  }
  if (body.rotation !== undefined && body.vertices !== undefined && body.offsets !== undefined) {
    return findNearestAsteroidImpact(body.position, toward, [
      {
        id: body.id,
        position: body.position,
        size: radius,
        rotation: body.rotation,
        vertices: body.vertices,
        offsets: body.offsets,
      },
    ])?.point;
  }
  const dx = toward.x - body.position.x;
  const dy = toward.y - body.position.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= radius) {
    return undefined;
  }
  return {
    x: body.position.x + (dx / distance) * radius,
    y: body.position.y + (dy / distance) * radius,
  };
}

/** Belt row → latch body. Forces `kind: 'asteroid'` so ship filters cannot reject it. */
export function harpoonBodyFromRock(roid: HarpoonRock): HarpoonFieldBody | undefined {
  if (!Number.isFinite(roid.position.x) || !Number.isFinite(roid.position.y)) {
    return undefined;
  }
  const id =
    typeof roid.id === 'string' && roid.id.length > 0
      ? roid.id
      : `rock:${roid.position.x.toFixed(1)},${roid.position.y.toFixed(1)}`;
  return {
    id,
    position: roid.position,
    velocity: roid.velocity,
    kind: 'asteroid',
    exploding: roid.exploding,
    health: roid.health,
    r: roid.r,
    rotation: roid.angle,
    vertices: roid.vertices,
    offsets: roid.offsets,
  };
}

export function harpoonBodyFromShip(
  id: string,
  ship: {
    position: Position;
    velocity: Velocity;
    factionId?: SoftFactionId;
    exploding?: boolean;
    health?: number;
    r?: number;
    shieldTimer?: number;
    shieldActive?: boolean;
  },
  factionId?: SoftFactionId
): HarpoonFieldBody {
  return {
    id,
    position: ship.position,
    velocity: ship.velocity,
    kind: 'ship',
    factionId: factionId ?? ship.factionId,
    exploding: ship.exploding,
    health: ship.health,
    r: ship.r,
    shieldTimer: ship.shieldTimer,
    shieldActive: ship.shieldActive,
  };
}

export function harpoonBodiesFromRocks(roids: readonly HarpoonRock[]): HarpoonFieldBody[] {
  const bodies: HarpoonFieldBody[] = [];
  for (const roid of roids) {
    const body = harpoonBodyFromRock(roid);
    if (body) {
      bodies.push(body);
    }
  }
  return bodies;
}

export function collectPlayHarpoonField(
  rocks: readonly HarpoonFieldBody[],
  ships: readonly HarpoonFieldBody[]
): HarpoonFieldBody[] {
  return [...rocks, ...ships];
}
