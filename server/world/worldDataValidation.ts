import { ECONOMY, emptySettlement, validSettlement } from '../../shared/economy';
import { epochField } from '../../shared/epochField';
import { validEquipment } from '../../shared/equipment';
import { finiteMotionVector } from '../../shared/playerMotion';
import { PLAYER_SHIELD } from '../../shared/playerShield';
import { releaseField } from '../../shared/releaseId';
import { isShipKitId } from '../../shared/shipKits';
import { validateAsteroidDto } from '../../shared/snapshotDto';
import { purchasedHullColor } from '../../shared/townStore';
import { parseSectorId, sectorAt, WORLD } from '../../shared/world';
import type { AsteroidData, Position, SavedPointLoot, SettlementState } from '../../shared-types';

import type { PersistentPilot, SavedEconomy } from './WorldStore';

const PILOT_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function validSectorId(id: string): boolean {
  return parseSectorId(id) !== null;
}

function validWorldPosition(position: Position): boolean {
  return finiteMotionVector(position) && Math.hypot(position.x, position.y) <= WORLD.radius;
}

function readVector(value: unknown): Position | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const vector = value as Record<string, unknown>;
  const x = vector['x'];
  const y = vector['y'];
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined;
  }
  return { x, y };
}

function readOptionalFlight(
  pilot: Record<string, unknown>
): Omit<PersistentPilot, 'id' | 'tokenHash' | 'name' | 'score'> | undefined {
  if (!('lastSeenAt' in pilot)) {
    return undefined;
  }
  const lastSeenAt = pilot['lastSeenAt'];
  const position = readVector(pilot['position']);
  const angle = pilot['angle'];
  const mass = pilot['mass'];
  const health = pilot['health'];
  const kitId = pilot['kitId'];
  const healthRegenTimer = pilot['healthRegenTimer'];
  if (
    typeof lastSeenAt !== 'number' ||
    !Number.isFinite(lastSeenAt) ||
    lastSeenAt < 0 ||
    !position ||
    !validWorldPosition(position) ||
    typeof angle !== 'number' ||
    !Number.isFinite(angle) ||
    typeof mass !== 'number' ||
    !Number.isFinite(mass) ||
    mass <= 0 ||
    typeof health !== 'number' ||
    !Number.isFinite(health) ||
    health < 0 ||
    !isShipKitId(kitId) ||
    (healthRegenTimer !== undefined &&
      (typeof healthRegenTimer !== 'number' ||
        !Number.isSafeInteger(healthRegenTimer) ||
        healthRegenTimer < 0))
  ) {
    return undefined;
  }
  const velocity = readVector(pilot['velocity']);
  return {
    lastSeenAt,
    kitId,
    position,
    angle,
    mass,
    health,
    ...(typeof healthRegenTimer === 'number' ? { healthRegenTimer } : {}),
    ...(typeof pilot['shieldFrames'] === 'number' &&
    Number.isSafeInteger(pilot['shieldFrames']) &&
    pilot['shieldFrames'] >= 0 &&
    pilot['shieldFrames'] <= PLAYER_SHIELD.durationFrames
      ? { shieldFrames: pilot['shieldFrames'] }
      : {}),
    ...(typeof pilot['shieldCooldownFrames'] === 'number' &&
    Number.isSafeInteger(pilot['shieldCooldownFrames']) &&
    pilot['shieldCooldownFrames'] >= 0 &&
    pilot['shieldCooldownFrames'] <= PLAYER_SHIELD.cooldownFrames
      ? { shieldCooldownFrames: pilot['shieldCooldownFrames'] }
      : {}),
    ...(velocity && finiteMotionVector(velocity) ? { velocity } : {}),
  };
}

function readReleaseProvenance(
  pilot: Record<string, unknown>
): Pick<
  PersistentPilot,
  | 'credentialReleaseId'
  | 'credentialClientReleaseId'
  | 'credentialIssuedAt'
  | 'scoreReleaseId'
  | 'scoreClientReleaseId'
  | 'scoreUpdatedAt'
  | 'lastClientReleaseId'
> {
  return {
    ...releaseField('credentialReleaseId', pilot['credentialReleaseId']),
    ...releaseField('credentialClientReleaseId', pilot['credentialClientReleaseId']),
    ...epochField('credentialIssuedAt', pilot['credentialIssuedAt']),
    ...releaseField('scoreReleaseId', pilot['scoreReleaseId']),
    ...releaseField('scoreClientReleaseId', pilot['scoreClientReleaseId']),
    ...epochField('scoreUpdatedAt', pilot['scoreUpdatedAt']),
    ...releaseField('lastClientReleaseId', pilot['lastClientReleaseId']),
  };
}

export function readSavedPilot(value: unknown): PersistentPilot | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const pilot = value as Record<string, unknown>;
  const id = pilot['id'];
  const name = pilot['name'];
  const tokenHash = pilot['tokenHash'];
  const score = pilot['score'];
  const equipment = pilot['equipment'];
  if (equipment !== undefined && !validEquipment(equipment)) {
    return undefined;
  }
  const cargo = pilot['cargo'];
  const purchases = pilot['purchases'];
  if (
    cargo !== undefined &&
    (typeof cargo !== 'number' || !Number.isSafeInteger(cargo) || cargo < 0)
  ) {
    return undefined;
  }
  if (
    purchases !== undefined &&
    (!Array.isArray(purchases) || !purchases.every((offerId) => typeof offerId === 'string'))
  ) {
    return undefined;
  }
  const silk = pilot['silk'];
  if (silk !== undefined && (typeof silk !== 'number' || !Number.isSafeInteger(silk) || silk < 0)) {
    return undefined;
  }
  const hullColor = pilot['hullColor'];
  if (hullColor !== undefined && typeof hullColor !== 'string') {
    return undefined;
  }
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof tokenHash !== 'string' ||
    !PILOT_TOKEN_HASH_PATTERN.test(tokenHash) ||
    typeof score !== 'number' ||
    !Number.isFinite(score)
  ) {
    return undefined;
  }
  return {
    id,
    tokenHash,
    name,
    score,
    ...(equipment !== undefined ? { equipment: [...equipment] } : {}),
    cargo: typeof cargo === 'number' ? cargo : 0,
    purchases: Array.isArray(purchases) ? purchases : [],
    ...(typeof silk === 'number' ? { silk } : {}),
    ...(typeof hullColor === 'string' && purchasedHullColor(hullColor) ? { hullColor } : {}),
    ...readOptionalFlight(pilot),
    ...readReleaseProvenance(pilot),
  };
}

/** Restore pose only when last-seen is present, recent, and the hull is alive. */
export function readSavedSector(id: string, value: unknown): AsteroidData[] {
  if (!validSectorId(id) || !Array.isArray(value)) {
    throw new Error(`Saved sector ${id} is invalid; refusing to regenerate mined deposits`);
  }
  const ids = new Set<string>();
  const rocks: AsteroidData[] = [];
  for (const [index, saved] of value.entries()) {
    // Retired finite burns never stored an owner. Preserve the deposit and
    // momentum, but cancel that uncreditable propulsion at the storage boundary.
    let candidate = saved;
    if (typeof saved === 'object' && saved !== null && 'boost' in saved) {
      const boost = saved.boost;
      if (
        typeof boost === 'object' &&
        boost !== null &&
        'phase' in boost &&
        boost.phase === 'burning' &&
        !('ownerId' in boost) &&
        'remainingFrames' in boost &&
        typeof boost.remainingFrames === 'number' &&
        Number.isInteger(boost.remainingFrames) &&
        boost.remainingFrames > 0 &&
        boost.remainingFrames <= 180 &&
        'angle' in boost &&
        typeof boost.angle === 'number' &&
        Number.isFinite(boost.angle)
      ) {
        candidate = { ...saved, boost: null };
      }
    }
    // Retire the saved cooperative marker without undoing prior migrations.
    if (typeof candidate === 'object' && candidate !== null && 'isCollabTarget' in candidate) {
      const { isCollabTarget: _retiredMarker, ...normalized } = candidate;
      candidate = normalized;
    }
    try {
      validateAsteroidDto(candidate);
    } catch (error) {
      throw new Error(`Saved sector ${id} asteroid ${index} is invalid`, {
        cause: error,
      });
    }
    if (
      candidate.id.length === 0 ||
      ids.has(candidate.id) ||
      !validWorldPosition(candidate.position) ||
      sectorAt(candidate.position).id !== id
    ) {
      throw new Error(`Saved sector ${id} contains an invalid or duplicate asteroid identity`);
    }
    ids.add(candidate.id);
    rocks.push(candidate);
  }
  return rocks;
}

function readSettlement(value: object): SettlementState {
  if (!('settlement' in value)) {
    return emptySettlement();
  }
  if (!validSettlement(value.settlement)) {
    throw new Error('Invalid saved settlement');
  }
  return value.settlement;
}
function readPointLoot(value: object): SavedPointLoot[] {
  if (!('pointLoot' in value)) {
    return [];
  }
  if (!Array.isArray(value.pointLoot)) {
    throw new Error('Invalid saved point loot');
  }
  const drops: SavedPointLoot[] = [];
  for (const row of value.pointLoot) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !finiteMotionVector(row.position) ||
      !Number.isSafeInteger(row.points) ||
      row.points < 0 ||
      typeof row.expiresAt !== 'number' ||
      !Number.isFinite(row.expiresAt) ||
      (row.velocity !== undefined && !finiteMotionVector(row.velocity)) ||
      (row.ejectFramesLeft !== undefined &&
        (!Number.isSafeInteger(row.ejectFramesLeft) ||
          row.ejectFramesLeft < 0 ||
          row.ejectFramesLeft > ECONOMY.cargoSpillEjectFrames))
    ) {
      throw new Error('Invalid saved point loot');
    }
    drops.push({
      id: row.id,
      position: { ...row.position },
      points: row.points,
      expiresAt: row.expiresAt,
      ...(row.velocity !== undefined ? { velocity: { ...row.velocity } } : {}),
      ...(row.ejectFramesLeft !== undefined ? { ejectFramesLeft: row.ejectFramesLeft } : {}),
    });
  }
  return drops;
}

export function readSavedEconomy(saved: unknown): SavedEconomy {
  if (saved === null || typeof saved !== 'object') {
    throw new Error('Invalid saved economy');
  }
  return { settlement: readSettlement(saved), pointLoot: readPointLoot(saved) };
}
