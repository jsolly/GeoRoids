import type { Position, ShipKitId, Velocity } from '../../../shared-types';
import { findHarpoonFieldBody, getHarpoonField, syncHarpoonFieldFromPlay } from './harpoonField';
import { getShipKit, SHIP_ABILITY, type ShipAbilityId } from './shipKits';
import { attachTowCable, tickTowCable } from './towCable';

export interface AbilityHost {
  id?: string;
  kitId: ShipKitId;
  position: Position;
  velocity: Velocity;
  angle: number;
  exploding: boolean;
  health: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;

  harpoonTargetId: string | null;
  harpoonLatchPos?: Position;
  r?: number;
}

/** Asteroid geometry shared by the client latch preview and authoritative towing. */
export interface AbilityBody {
  id: string;
  position: Position;
  velocity: Velocity;
  exploding?: boolean;
  health?: number;
  r?: number;
  size?: number;
}

export interface AbilityWorld {
  asteroids: readonly AbilityBody[];
}

interface AbilityActivation {
  activated: boolean;
  abilityId?: ShipAbilityId;
}

interface HarpoonLatchSnapshot {
  harpoonTargetId?: string | null;
  harpoonLatchPos?: Position;
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

export function canActivateAbility(host: AbilityHost): boolean {
  return !host.exploding && host.health > 0 && host.abilityCooldownFrames <= 0;
}

function clearHarpoonLatch(host: Pick<AbilityHost, 'harpoonTargetId' | 'harpoonLatchPos'>): void {
  host.harpoonTargetId = null;
  delete host.harpoonLatchPos;
}

function listHarpoonCandidates(world?: AbilityWorld): readonly AbilityBody[] {
  return world?.asteroids ?? getHarpoonField();
}

function isHarpoonableBody(body: AbilityBody): boolean {
  return !body.exploding && (body.health === undefined || body.health > 0);
}

export function tickAbilityHost(host: AbilityHost): void {
  if (host.abilityCooldownFrames > 0) {
    host.abilityCooldownFrames -= 1;
  }
  if (host.abilityActiveFrames > 0) {
    host.abilityActiveFrames -= 1;
  }
  if (host.kitId !== 'hauler' || host.exploding || host.health <= 0) {
    clearHarpoonLatch(host);
  }
}

/** Explicit null detaches the tow on every client. */
export function applySharedHarpoonLatch(
  host: Pick<AbilityHost, 'kitId' | 'harpoonTargetId' | 'harpoonLatchPos'>,
  snapshot: HarpoonLatchSnapshot
): void {
  if (host.kitId !== 'hauler') {
    clearHarpoonLatch(host);
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

const NEAREST_GAP_TIE_WU = 24;

function pickNearestHarpoonBody(
  host: Pick<AbilityHost, 'position' | 'angle' | 'r'>,
  bodies: readonly AbilityBody[],
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
    // Prefer the closest hull gap, using facing to choose between neighboring rocks.
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
  host: Pick<AbilityHost, 'position' | 'angle' | 'r'>,
  bodies: readonly AbilityBody[],
  range: number = SHIP_ABILITY.HARPOON_RANGE
): AbilityBody | undefined {
  const valid = bodies.filter(isHarpoonableBody);
  return pickNearestHarpoonBody(host, valid, range);
}

interface HarpoonDiagnosis {
  kitId: ShipKitId;
  canActivate: boolean;
  fieldCount: number;
  range: number;
  targetId?: string;
  nearest?: { id?: string; dist: number; gap: number; reason: string };
}

/** QA probe: kit, field, nearest gap, reject reason, chosen latch. */
export function diagnoseHarpoonLatch(host: AbilityHost, world?: AbilityWorld): HarpoonDiagnosis {
  if (!world) {
    syncHarpoonFieldFromPlay();
  }
  const range = SHIP_ABILITY.HARPOON_RANGE;
  const candidates = listHarpoonCandidates(world);
  let nearest: HarpoonDiagnosis['nearest'];
  for (const body of candidates) {
    const dist = Math.hypot(body.position.x - host.position.x, body.position.y - host.position.y);
    const gap = dist - bodyRadius(host) - bodyRadius(body);
    let reason = 'ok';
    if (!isHarpoonableBody(body)) {
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
  if (!isHarpoonableBody(target)) {
    return false;
  }
  return harpoonSurfaceGap(host, target) <= range * SHIP_ABILITY.HARPOON_SLACK;
}

/** Hauler-only: advance the authoritative tow cable. */
export function pullHarpoonTarget(host: AbilityHost, bodies: readonly AbilityBody[]): void {
  if (host.kitId !== 'hauler') {
    tickTowCable(host, undefined);
    clearHarpoonLatch(host);
    return;
  }
  if (!host.harpoonTargetId) {
    tickTowCable(host, undefined);
    return;
  }

  const targetId = host.harpoonTargetId;
  const target = bodies.find((body) => body.id === targetId);
  // A missing authoritative target detaches the cable.
  if (!target || !latchStillValid(host, target, SHIP_ABILITY.HARPOON_RANGE * 3)) {
    tickTowCable(host, undefined);
    clearHarpoonLatch(host);
    return;
  }

  tickTowCable(host, target);
}

/**
 * Activate the host's kit ability. World effects (harpoon haul) apply
 * when a world is passed — server is authoritative for those.
 */
export function activateAbilityOnHost(host: AbilityHost, world?: AbilityWorld): AbilityActivation {
  if (host.kitId === 'hauler' && host.harpoonTargetId && !host.exploding && host.health > 0) {
    clearHarpoonLatch(host);
    return { activated: true, abilityId: 'harpoon' };
  }
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

  if (kit.abilityId === 'harpoon') {
    if (host.kitId !== 'hauler') {
      return { activated: false };
    }
    const latchRange = SHIP_ABILITY.HARPOON_RANGE;
    const target = findHarpoonTarget(host, listHarpoonCandidates(world), latchRange);
    if (!target) {
      return { activated: false };
    }
    host.abilityCooldownFrames = SHIP_ABILITY.COOLDOWN_FRAMES[kit.id];
    host.harpoonTargetId = target.id;

    host.harpoonLatchPos = { x: target.position.x, y: target.position.y };
    // Local prediction paints the latch; the authoritative world supplies towing forces.
    if (world?.asteroids.includes(target)) {
      attachTowCable(host, target);
    }
    return { activated: true, abilityId: 'harpoon' };
  }

  return { activated: false };
}
