import { areAllied } from '../../../shared/factions';
import type { Position, ShipKitId, SoftFactionId, Velocity } from '../../../shared-types';
import {
  findHarpoonFieldBody,
  getHarpoonField,
  getHarpoonFieldCanvas,
  getHarpoonFieldScale,
  harpoonTargetIdsMatch,
  syncHarpoonFieldFromPlay,
} from './harpoonField';
import { slingHarpoonAsteroid, tickHarpoonSling } from './harpoonSling';
import { getShipKit, SHIP_ABILITY, type ShipAbilityId } from './shipKits';

export interface AbilityHost {
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

  harpoonTimer: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
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

  /** Timed F shield. */
  shieldActive?: boolean;
  respawnTimer?: number;
  spawnProtectionTimer?: number;
}

export interface AbilityWorld {
  asteroids: AbilityBody[];
  entities: AbilityBody[];
  playfieldScale?: number;
  canvas?: { width: number; height: number };
}

interface AbilityActivation {
  activated: boolean;
  abilityId?: ShipAbilityId;
}

interface HarpoonLatchSnapshot {
  harpoonTimer?: number;
  harpoonTargetId?: string;
  harpoonLatchPos?: Position;
}

/** Used when KeyE fires before the first render publishes a canvas. */
const DEFAULT_LATCH_CANVAS = { width: 1920, height: 1080 };

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

export function canActivateAbility(host: AbilityHost): boolean {
  return !host.exploding && host.health > 0 && host.abilityCooldownFrames <= 0;
}

function clearHarpoonLatch(
  host: Pick<AbilityHost, 'harpoonTimer' | 'harpoonTargetId' | 'harpoonLatchPos'>
): void {
  host.harpoonTimer = 0;
  delete host.harpoonTargetId;
  delete host.harpoonLatchPos;
}

/** Rocks + ships share one latch list. Server and client use the same helper. */
function listHarpoonCandidates(world?: AbilityWorld): AbilityBody[] {
  if (world) {
    return [...world.asteroids, ...world.entities];
  }
  return [...getHarpoonField()];
}

/** Rocks are environment. Ship combat filters must not reject a visible belt row. */
export function isEnvironmentLatchBody(body: AbilityBody): boolean {
  if (body.kind === 'asteroid') {
    return !body.exploding;
  }
  if (body.kind === 'ship' || body.factionId !== undefined) {
    return false;
  }
  if (body.shieldActive) {
    return false;
  }
  return true;
}

function isHarpoonableBody(
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
  if (body.shieldActive) {
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
  if (host.harpoonTimer > 0) {
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

function bodyRadius(body: Pick<AbilityBody, 'r' | 'size'>): number {
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

function pickNearestHarpoonBody(
  host: Pick<AbilityHost, 'position' | 'angle' | 'r'>,
  bodies: AbilityBody[],
  range: number
): AbilityBody | undefined {
  const hx = Math.cos(host.angle);
  const hy = -Math.sin(host.angle);
  let best: { body: AbilityBody; gap: number; facing: number } | undefined;

  for (const body of bodies) {
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

export function findHarpoonTarget(
  host: Pick<AbilityHost, 'id' | 'factionId' | 'position' | 'angle' | 'r'>,
  bodies: AbilityBody[],
  range: number = SHIP_ABILITY.HARPOON_RANGE
): AbilityBody | undefined {
  const valid = bodies.filter((body) => isHarpoonableBody(host, body));
  // A rock on this canvas is the product target. Hostile ships stay valid
  // when no environment body is in reach — same-side mates never do.
  return (
    pickNearestHarpoonBody(
      host,
      valid.filter((body) => isEnvironmentLatchBody(body)),
      range
    ) ??
    pickNearestHarpoonBody(
      host,
      valid.filter((body) => !isEnvironmentLatchBody(body)),
      range
    )
  );
}

interface HarpoonDiagnosis {
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
  return harpoonTargetIdsMatch(body.id, id);
}

/** Hauler-only: haul ships or advance an authoritative asteroid reel. */
export function pullHarpoonTarget(host: AbilityHost, bodies: AbilityBody[]): void {
  if (host.kitId !== 'hauler') {
    tickHarpoonSling(host, undefined, bodies);
    clearHarpoonLatch(host);
    return;
  }
  if (host.harpoonTimer <= 0 || !host.harpoonTargetId) {
    tickHarpoonSling(host, undefined, bodies);
    return;
  }

  const targetId = host.harpoonTargetId;
  const target =
    bodies.find((body) => body.id === targetId && body.id !== host.id) ??
    bodies.find((body) => body.id !== host.id && bodyMatchesLatchId(body, targetId)) ??
    findHarpoonFieldBody(targetId);
  // Keep cream VFX (timer + latchPos) if the field id is mid-sync. #481
  // cleared here and left abilityActiveFrames — activation ring, no tether.
  if (!target || !latchStillValid(host, target, SHIP_ABILITY.HARPOON_RANGE_MAX)) {
    tickHarpoonSling(host, undefined, bodies);
    return;
  }

  if (isEnvironmentLatchBody(target)) {
    tickHarpoonSling(
      host,
      target,
      bodies.filter((body) => !isEnvironmentLatchBody(body))
    );
    return;
  }

  const dist = Math.hypot(target.position.x - host.position.x, target.position.y - host.position.y);
  const falloff = 1 - Math.min(dist, SHIP_ABILITY.HARPOON_RANGE) / SHIP_ABILITY.HARPOON_RANGE;
  pullBody(target, host.position, SHIP_ABILITY.HARPOON_PULL * Math.max(0.25, falloff));
}

function resolveAbilityWorld(world?: AbilityWorld): AbilityWorld | undefined {
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
 * Activate the host's kit ability. World effects (harpoon haul) apply
 * when a world is passed — server is authoritative for those.
 */
export function activateAbilityOnHost(host: AbilityHost, world?: AbilityWorld): AbilityActivation {
  if (!canActivateAbility(host)) {
    return { activated: false };
  }

  const kit = getShipKit(host.kitId);
  if (kit.abilityId === 'surveyScan') {
    host.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES[kit.id];
    host.abilityActiveFrames = SHIP_ABILITY.SCAN_FRAMES;
    return { activated: true, abilityId: kit.abilityId };
  }
  if (!world) {
    syncHarpoonFieldFromPlay();
  }
  const resolved = resolveAbilityWorld(world);

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
    // Local prediction only paints the latch. Launch using the authoritative
    // world, whose enemy rows include complete protection and respawn state.
    if (world?.asteroids.includes(target)) {
      slingHarpoonAsteroid(host, target, world.entities);
    }
    return { activated: true, abilityId: 'harpoon' };
  }

  return { activated: false };
}
