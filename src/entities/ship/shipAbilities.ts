import { areAllied } from '../../../shared/factions';
import { type FuelTank, trySpendEmpFuel } from '../../../shared/fuel';
import type { AsteroidMotionState, Position, SoftFactionId, Velocity } from '../../../shared-types';
import {
  findHarpoonFieldBody,
  getHarpoonField,
  getHarpoonFieldCanvas,
  getHarpoonFieldScale,
  syncHarpoonFieldFromPlay,
} from './harpoonField';
import { getShipKit, SHIP_ABILITY, type ShipAbilityId, type ShipKitId } from './shipKits';

export interface AbilityHost extends FuelTank {
  id?: string;
  kitId: ShipKitId;
  factionId?: SoftFactionId;
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  health: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldTimer: number;
  harpoonTimer: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
  asteroidMotion?: AsteroidMotionState;
  r?: number;
}

export interface AbilityBody {
  id?: string;
  position: Position;
  velocity: Velocity;
  kind?: 'asteroid' | 'ship';
  factionId?: SoftFactionId;
  exploding?: boolean;
  health?: number;
  r?: number;
  size?: number;
  shieldTimer?: number;
  /** Timed ship shield (#454). Separate from Warden kit `shieldTimer`. */
  shieldActive?: boolean;
}

export interface AbilityWorld {
  asteroids: AbilityBody[];
  entities: AbilityBody[];
  playfieldScale?: number;
  canvas?: { width: number; height: number };
}

export interface AbilityActivation {
  activated: boolean;
  abilityId?: ShipAbilityId;
}

export interface HarpoonLatchSnapshot {
  harpoonTimer?: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
}

/** Used when KeyE fires before the first render publishes a canvas. */
const DEFAULT_LATCH_CANVAS = { width: 1280, height: 720 };

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

function headingVelocity(angle: number, magnitude: number): Velocity {
  return {
    x: Math.cos(angle) * magnitude,
    y: -Math.sin(angle) * magnitude,
  };
}

export function canActivateAbility(host: AbilityHost): boolean {
  return (
    !host.exploding &&
    host.health > 0 &&
    host.abilityCooldownFrames <= 0 &&
    host.asteroidMotion?.mode !== 'latched'
  );
}

export function absorbDamageWithShield(host: { shieldTimer: number }): boolean {
  return host.shieldTimer > 0;
}

export function clearHarpoonLatch(
  host: Pick<AbilityHost, 'harpoonTimer' | 'harpoonTargetId' | 'harpoonLatchPos'>
): void {
  host.harpoonTimer = 0;
  delete host.harpoonTargetId;
  delete host.harpoonLatchPos;
}

/** Rocks + ships share one latch list. Server and client use the same helper. */
export function listHarpoonCandidates(world?: AbilityWorld): AbilityBody[] {
  if (world) {
    return [...world.asteroids, ...world.entities];
  }
  return [...getHarpoonField()];
}

/** Rocks are environment. Ship combat filters must not reject a visible belt row. */
export function isEnvironmentLatchBody(body: AbilityBody): boolean {
  if (body.kind === 'ship' || body.factionId !== undefined) {
    return false;
  }
  if (body.shieldActive || (body.shieldTimer ?? 0) > 0) {
    return false;
  }
  return true;
}

export function isHarpoonableBody(
  host: Pick<AbilityHost, 'id' | 'factionId'>,
  body: AbilityBody
): boolean {
  if (body.id && body.id === host.id) {
    return false;
  }
  if (isEnvironmentLatchBody(body)) {
    return !body.exploding;
  }
  // A Hauler can pull neutral rocks and hostile ships, but must never latch
  // onto a same-faction mate. Keep this in the shared predicate so client
  // prediction and the authoritative server make the same choice.
  if (areAllied(host.factionId, body.factionId)) {
    return false;
  }
  if (!body.id) {
    return false;
  }
  if (body.exploding || (body.health !== undefined && body.health <= 0)) {
    return false;
  }
  if ((body.shieldTimer ?? 0) > 0 || body.shieldActive) {
    return false;
  }
  return true;
}

export function tickAbilityHost(host: AbilityHost): void {
  if (host.abilityCooldownFrames > 0) {
    host.abilityCooldownFrames -= 1;
  }
  if (host.abilityActiveFrames > 0) {
    host.abilityActiveFrames -= 1;
  }
  if (host.shieldTimer > 0) {
    host.shieldTimer -= 1;
  }
  if (
    host.kitId === 'hauler' &&
    host.asteroidMotion?.mode === 'latched' &&
    !host.exploding &&
    host.health > 0
  ) {
    // An asteroid latch lasts until its ownership state changes, across render
    // frames and transport gaps. The ordinary E ability still expires below.
    host.harpoonTimer = Math.max(1, host.harpoonTimer);
  } else if (host.harpoonTimer > 0) {
    host.harpoonTimer -= 1;
    if (host.harpoonTimer <= 0 || host.kitId !== 'hauler') {
      clearHarpoonLatch(host);
    }
  } else if (host.kitId !== 'hauler' && host.harpoonTargetId) {
    clearHarpoonLatch(host);
  }
}

/**
 * Local predicts; remotes stay snapshot-driven. A later server latch
 * (timer > 0) wins so both clients draw the same tether.
 */
export function applySharedHarpoonLatch(
  host: Pick<AbilityHost, 'kitId' | 'harpoonTimer' | 'harpoonTargetId' | 'harpoonLatchPos'>,
  snapshot: HarpoonLatchSnapshot,
  role: 'predicting' | 'authoritative' = 'authoritative'
): void {
  if (host.kitId !== 'hauler') {
    clearHarpoonLatch(host);
    return;
  }
  if (snapshot.harpoonTimer === undefined && snapshot.harpoonTargetId === undefined) {
    return;
  }
  if (snapshot.harpoonTimer !== undefined && snapshot.harpoonTimer > 0) {
    host.harpoonTimer = snapshot.harpoonTimer;
    if (snapshot.harpoonTargetId !== undefined) {
      const harpoonTargetIdValue = snapshot.harpoonTargetId || undefined;
      if (harpoonTargetIdValue !== undefined) {
        host.harpoonTargetId = harpoonTargetIdValue;
      } else {
        delete host.harpoonTargetId;
      }
    }
    rememberLatchPos(host, snapshot);
    return;
  }
  if (role === 'predicting') {
    return;
  }
  if (snapshot.harpoonTimer !== undefined) {
    host.harpoonTimer = snapshot.harpoonTimer;
  }
  if (snapshot.harpoonTargetId !== undefined) {
    const harpoonTargetIdValue = snapshot.harpoonTargetId || undefined;
    if (harpoonTargetIdValue !== undefined) {
      host.harpoonTargetId = harpoonTargetIdValue;
    } else {
      delete host.harpoonTargetId;
    }
  }
  if (host.harpoonTimer <= 0) {
    delete host.harpoonTargetId;
  }
}

function pushBody(body: AbilityBody, toward: Position, force: number): void {
  const dx = body.position.x - toward.x;
  const dy = body.position.y - toward.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    return;
  }
  body.velocity.x += (dx / dist) * force;
  body.velocity.y += (dy / dist) * force;
}

function pullBody(body: AbilityBody, toward: Position, force: number): void {
  const dx = toward.x - body.position.x;
  const dy = toward.y - body.position.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) {
    return;
  }
  body.velocity.x += (dx / dist) * force;
  body.velocity.y += (dy / dist) * force;
}

export function bodyRadius(body: Pick<AbilityBody, 'r' | 'size'>): number {
  const value = body.r ?? body.size;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Gap from hull to hull. Negative means the ship is inside the target. */
export function harpoonSurfaceGap(
  host: Pick<AbilityHost, 'position' | 'r'>,
  body: AbilityBody
): number {
  const dist = Math.hypot(body.position.x - host.position.x, body.position.y - host.position.y);
  return dist - bodyRadius(host) - bodyRadius(body);
}

/**
 * World-unit latch reach from what the pilot can see.
 * #480 used max(280, 320px / scale) capped at 1600wu. On a 1:1 1080p view
 * that is 320wu — a rock 400–900px from the ship looks adjacent and misses.
 * Deep zoom (scale 0.1) turned a 200px-near rock into 2000wu and the cap
 * dropped it. Reach is the on-screen half-diagonal / scale so "near on
 * this canvas" latches at 1:1 and zoomed.
 */
export function harpoonLatchRange(
  playfieldScale = 1,
  canvas?: { width: number; height: number }
): number {
  const scale = Number.isFinite(playfieldScale) && playfieldScale > 0 ? playfieldScale : 1;
  const view = canvas && canvas.width > 0 && canvas.height > 0 ? canvas : DEFAULT_LATCH_CANVAS;
  const onScreen = Math.hypot(view.width, view.height) / 2 / scale;
  // Any hull on this canvas is in reach. Do not clip to HARPOON_RANGE_MAX —
  // that cap is pull slack, not latch.
  return Math.max(SHIP_ABILITY.HARPOON_RANGE, onScreen, SHIP_ABILITY.HARPOON_VISUAL_PX / scale);
}

const NEAREST_GAP_TIE_WU = 24;

export function findHarpoonTarget(
  host: Pick<AbilityHost, 'id' | 'factionId' | 'position' | 'angle' | 'r'>,
  bodies: AbilityBody[],
  range: number = SHIP_ABILITY.HARPOON_RANGE
): AbilityBody | undefined {
  const hx = Math.cos(host.angle);
  const hy = -Math.sin(host.angle);
  let best: { body: AbilityBody; gap: number; facing: number } | undefined;

  for (const body of bodies) {
    if (!isHarpoonableBody(host, body)) {
      continue;
    }
    const dx = body.position.x - host.position.x;
    const dy = body.position.y - host.position.y;
    const dist = Math.hypot(dx, dy);
    const gap = dist - bodyRadius(host) - bodyRadius(body);
    if (gap > range) {
      continue;
    }
    const facing = dist < 1 ? 1 : (dx * hx + dy * hy) / dist;
    // QA "next to a rock" is hull gap, not nose-forward. A distant bot
    // ahead used to steal the latch, then pull-clear left activation-only.
    if (
      !best ||
      gap < best.gap - NEAREST_GAP_TIE_WU ||
      (Math.abs(gap - best.gap) <= NEAREST_GAP_TIE_WU && facing > best.facing) ||
      (Math.abs(gap - best.gap) <= NEAREST_GAP_TIE_WU && facing === best.facing && gap < best.gap)
    ) {
      best = { body, gap, facing };
    }
  }

  return best?.body;
}

export interface HarpoonDiagnosis {
  kitId: ShipKitId;
  canActivate: boolean;
  fieldCount: number;
  scale: number;
  range: number;
  targetId?: string;
  nearest?: { id?: string; dist: number; gap: number; reason: string };
}

/** QA probe: kit, field, nearest gap, reject reason, chosen latch. */
export function diagnoseHarpoonLatch(host: AbilityHost, world?: AbilityWorld): HarpoonDiagnosis {
  if (!world) {
    syncHarpoonFieldFromPlay();
  }
  const resolved = resolveAbilityWorld(world);
  const scale = world?.playfieldScale ?? getHarpoonFieldScale();
  const canvas = world?.canvas ?? getHarpoonFieldCanvas();
  const range = harpoonLatchRange(scale, canvas);
  const candidates = listHarpoonCandidates(resolved);
  let nearest: HarpoonDiagnosis['nearest'];
  for (const body of candidates) {
    const dist = Math.hypot(body.position.x - host.position.x, body.position.y - host.position.y);
    const gap = dist - bodyRadius(host) - bodyRadius(body);
    let reason = 'ok';
    if (!isHarpoonableBody(host, body)) {
      reason = 'rejected';
    } else if (gap > range) {
      reason = 'out-of-range';
    }
    if (!nearest || gap < nearest.gap) {
      nearest = { ...(body.id !== undefined ? { id: body.id } : {}), dist, gap, reason };
    }
  }
  const targetId = findHarpoonTarget(host, candidates, range)?.id;
  return {
    kitId: host.kitId,
    canActivate: canActivateAbility(host),
    fieldCount: candidates.length,
    scale,
    range,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(nearest !== undefined ? { nearest: nearest } : {}),
  };
}

function latchStillValid(
  host: AbilityHost,
  target: AbilityBody,
  range: number = SHIP_ABILITY.HARPOON_RANGE
): boolean {
  if (!isHarpoonableBody(host, target)) {
    return false;
  }
  return harpoonSurfaceGap(host, target) <= range * SHIP_ABILITY.HARPOON_SLACK;
}

function bodyMatchesLatchId(body: AbilityBody, id: string): boolean {
  if (!body.id) {
    return false;
  }
  return body.id === id || body.id.endsWith(id) || id.endsWith(body.id);
}

/** Hauler-only: haul the latched rock or ship. Other kits never pull. */
export function pullHarpoonTarget(host: AbilityHost, bodies: AbilityBody[]): void {
  if (host.kitId !== 'hauler') {
    clearHarpoonLatch(host);
    return;
  }
  if (host.harpoonTimer <= 0 || !host.harpoonTargetId) {
    return;
  }

  const targetId = host.harpoonTargetId;
  const target =
    bodies.find((body) => body !== host && bodyMatchesLatchId(body, targetId)) ??
    findHarpoonFieldBody(targetId);
  // Keep cream VFX (timer + latchPos) if the field id is mid-sync. #481
  // cleared here and left abilityActiveFrames — activation ring, no tether.
  if (!target || !latchStillValid(host, target, SHIP_ABILITY.HARPOON_RANGE_MAX)) {
    return;
  }

  const dist = Math.hypot(target.position.x - host.position.x, target.position.y - host.position.y);
  const falloff = 1 - Math.min(dist, SHIP_ABILITY.HARPOON_RANGE) / SHIP_ABILITY.HARPOON_RANGE;
  pullBody(target, host.position, SHIP_ABILITY.HARPOON_PULL * Math.max(0.25, falloff));
}

export function applyShockPulse(host: AbilityHost, world: AbilityWorld): void {
  for (const asteroid of world.asteroids) {
    const dist = Math.hypot(
      asteroid.position.x - host.position.x,
      asteroid.position.y - host.position.y
    );
    if (dist > SHIP_ABILITY.SHOCK_RADIUS || dist < 1) {
      continue;
    }
    const falloff = 1 - dist / SHIP_ABILITY.SHOCK_RADIUS;
    pushBody(asteroid, host.position, SHIP_ABILITY.SHOCK_FORCE * falloff);
  }
  for (const entity of world.entities) {
    const dist = Math.hypot(
      entity.position.x - host.position.x,
      entity.position.y - host.position.y
    );
    if (dist > SHIP_ABILITY.SHOCK_RADIUS || dist < 1) {
      continue;
    }
    const falloff = 1 - dist / SHIP_ABILITY.SHOCK_RADIUS;
    pushBody(entity, host.position, SHIP_ABILITY.SHOCK_FORCE * falloff);
  }
}

export function resolveAbilityWorld(world?: AbilityWorld): AbilityWorld | undefined {
  if (world) {
    return world;
  }
  const field = getHarpoonField();
  if (field.length === 0) {
    return undefined;
  }
  const asteroids: AbilityBody[] = [];
  const entities: AbilityBody[] = [];
  for (const body of field) {
    if (body.kind === 'ship') {
      entities.push(body);
    } else {
      asteroids.push(body);
    }
  }
  return { asteroids, entities };
}

/**
 * Activate the host's kit ability. World effects (harpoon haul / shock) apply
 * when a world is passed — server is authoritative for those.
 */
export function activateAbilityOnHost(host: AbilityHost, world?: AbilityWorld): AbilityActivation {
  if (!canActivateAbility(host)) {
    return { activated: false };
  }

  const kit = getShipKit(host.kitId);
  if (!world) {
    syncHarpoonFieldFromPlay();
  }
  const resolved = resolveAbilityWorld(world);

  // Quake shock is the live EMP. Empty tank refuses; other kits stay free.
  if (kit.abilityId === 'shockPulse' && !trySpendEmpFuel(host)) {
    return { activated: false };
  }

  if (kit.abilityId === 'harpoon') {
    if (host.kitId !== 'hauler') {
      return { activated: false };
    }
    const latchRange = harpoonLatchRange(
      world?.playfieldScale ?? getHarpoonFieldScale(),
      world?.canvas ?? getHarpoonFieldCanvas()
    );
    const target = findHarpoonTarget(host, listHarpoonCandidates(resolved), latchRange);
    if (!target) {
      return { activated: false };
    }
    host.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES[kit.id];
    if (target.id !== undefined) {
      host.harpoonTargetId = target.id;
    } else {
      delete host.harpoonTargetId;
    }
    host.harpoonTimer = SHIP_ABILITY.HARPOON_FRAMES;
    host.abilityActiveFrames = SHIP_ABILITY.HARPOON_FRAMES;
    host.harpoonLatchPos = { x: target.position.x, y: target.position.y };
    return { activated: true, abilityId: 'harpoon' };
  }

  host.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES[kit.id];

  switch (kit.abilityId) {
    case 'boostDash': {
      const boost = headingVelocity(host.angle, SHIP_ABILITY.DASH_BOOST);
      host.velocity.x += boost.x;
      host.velocity.y += boost.y;
      host.abilityActiveFrames = 12;
      break;
    }
    case 'shieldFocus':
      host.shieldTimer = SHIP_ABILITY.SHIELD_FRAMES;
      host.abilityActiveFrames = SHIP_ABILITY.SHIELD_FRAMES;
      break;
    case 'burstFire':
      host.abilityActiveFrames = 8;
      break;
    case 'shockPulse':
      host.abilityActiveFrames = 18;
      if (resolved) {
        applyShockPulse(host, resolved);
      }
      break;
  }

  return { activated: true, abilityId: kit.abilityId };
}
