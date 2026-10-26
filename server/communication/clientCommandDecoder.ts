import { isContourLockState } from '../../shared/contourLock';
import { readReleaseId } from '../../shared/releaseId';
import { isShipKitId } from '../../shared/shipKits';
import { isHaulerUtilityId, isScoutUtilityId } from '../../shared/shipUtilities';
import { ASTEROID_INTERACTIONS_CAPABILITY, SNAPSHOT_VERSION } from '../../shared/snapshotProtocol';
import { storeOffer } from '../../shared/townStore';
import { WORLD } from '../../shared/world';
import type {
  ContourLockState,
  CrewAction,
  HaulerUtilityId,
  PingMessage,
  Position,
  ScoutUtilityId,
  ShipKitId,
  SnapshotAcknowledgement,
  Velocity,
  WeaponChargeAction,
} from '../../shared-types';

type WireRecord = Record<string, unknown>;

const SHOT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface PlayerMovementUpdate {
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  thrusting?: boolean;
  contourLock?: ContourLockState | null;
  overlayHold?: boolean;
}

export type ClientCommand =
  | {
      type: 'join';
      id: string;
      name: string;
      position: Position;
      kitId?: ShipKitId;
      resumeRequested: boolean;
      cooperativeVersion?: 1;
      worldRemains?: 1;

      resumeToken?: string;
      clientReleaseId?: string;
    }
  | { type: 'travelFurnace'; id: string; destinationId: string }
  | { type: 'equipSatellite'; id: string; pickupId: string }
  | { type: 'leave' }
  | { type: 'snapshotResync' }
  | ({ type: 'snapshotAck' } & SnapshotAcknowledgement)
  | { type: 'crewAction'; id: string; action: CrewAction }
  | { type: 'useAbility'; id: string }
  | { type: 'chargeWeapon'; id: string; action: WeaponChargeAction }
  | {
      type: 'setHaulerUtility';
      id: string;
      utilityId: HaulerUtilityId;
    }
  | {
      type: 'setScoutUtility';
      id: string;
      utilityId: ScoutUtilityId;
    }
  | {
      type: 'buyStoreItem';
      id: string;
      offerId: string;
    }
  | {
      type: 'update';
      id: string;
      update: PlayerMovementUpdate;
      motionEpoch?: number;
      motionSequence?: number;
    }
  | {
      type: 'shoot';
      id: string;
      laserStart: Position;
      laserDirection: Velocity;
      requestId?: string;
    }
  | PingMessage;

type ClientCommandDecodeResult =
  | { ok: true; command: ClientCommand }
  | {
      ok: false;
      messageType?: string;
      error?: string;
      logUnknown?: boolean;
    };

function isRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): WireRecord {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function readFinitePosition(value: unknown): Position | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const x = readFiniteNumber(value['x']);
  const y = readFiniteNumber(value['y']);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readJoinPosition(value: unknown): Position | undefined {
  if (value === undefined) {
    return { x: 0, y: 0 };
  }
  const position = readFinitePosition(value);
  return position && Math.hypot(position.x, position.y) <= WORLD.radius ? position : undefined;
}

function invalid(messageType: string, error?: string): ClientCommandDecodeResult {
  return {
    ok: false,
    messageType,
    ...(error !== undefined ? { error } : {}),
  };
}

function decodeUpdate(id: string, fields: WireRecord): ClientCommandDecodeResult {
  const rawPosition = fields['position'];
  const rawVelocity = fields['velocity'];
  const rawAngle = fields['angle'];
  const rawThrusting = fields['thrusting'];
  const rawContourLock = fields['contourLock'];
  const rawOverlayHold = fields['overlayHold'];
  const position = readFinitePosition(rawPosition);
  const velocity = readFinitePosition(rawVelocity);
  const angle = readFiniteNumber(rawAngle);
  const thrusting = typeof rawThrusting === 'boolean' ? rawThrusting : undefined;
  const contourLock =
    rawContourLock === null || isContourLockState(rawContourLock) ? rawContourLock : undefined;

  if (
    !id ||
    (rawPosition !== undefined && position === undefined) ||
    (rawVelocity !== undefined && velocity === undefined) ||
    (rawAngle !== undefined && angle === undefined) ||
    (rawThrusting !== undefined && thrusting === undefined) ||
    (rawContourLock !== undefined && contourLock === undefined) ||
    (rawOverlayHold !== undefined && typeof rawOverlayHold !== 'boolean')
  ) {
    return invalid('update', !id ? 'Missing player ID' : 'Invalid player movement update');
  }

  const update: PlayerMovementUpdate = {
    ...(position !== undefined ? { position } : {}),
    ...(velocity !== undefined ? { velocity } : {}),
    ...(angle !== undefined ? { angle } : {}),
    ...(thrusting !== undefined ? { thrusting } : {}),
    ...(contourLock !== undefined ? { contourLock } : {}),
    ...(typeof rawOverlayHold === 'boolean' ? { overlayHold: rawOverlayHold } : {}),
  };
  const motionEpoch = readSafeInteger(fields['motionEpoch']);
  const motionSequence = readSafeInteger(fields['motionSequence']);
  return {
    ok: true,
    command: {
      type: 'update',
      id,
      update,
      ...(motionEpoch !== undefined ? { motionEpoch } : {}),
      ...(motionSequence !== undefined ? { motionSequence } : {}),
    },
  };
}

/** Kit selection is authoritative at join; extra request fields are ignored. */
function decodeUseAbility(id: string): ClientCommandDecodeResult {
  return id
    ? { ok: true, command: { type: 'useAbility', id } }
    : invalid('useAbility', 'Missing player ID for useAbility');
}

export function decodeClientCommand(message: unknown): ClientCommandDecodeResult {
  if (!isRecord(message)) {
    return { ok: false, error: 'Invalid message format' };
  }

  const type = readString(message['type']);
  if (type === undefined) {
    return { ok: false, error: 'Unknown message type: undefined', logUnknown: true };
  }
  const payload = asRecord(message['data']);
  const id = readString(message['id']) ?? readString(payload['id']) ?? '';
  const name = readString(message['name']) ?? readString(payload['name']) ?? '';
  const fields: WireRecord = { ...payload, ...message };
  delete fields['type'];
  delete fields['id'];
  delete fields['name'];
  delete fields['data'];

  switch (type) {
    case 'join': {
      if (
        !id ||
        !name ||
        Buffer.byteLength(id) > 128 ||
        Buffer.byteLength(name) > 64 ||
        [...id, ...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      ) {
        return invalid(type, 'Player ID or name is missing or invalid');
      }
      const kitOffer = message['kitId'] ?? payload['kitId'];
      const snapshotOffer = message['snapshotVersion'] ?? payload['snapshotVersion'];
      const asteroidInteractionsOffer =
        message['asteroidInteractions'] ?? payload['asteroidInteractions'];
      const remainsOffer = message['worldRemains'] ?? payload['worldRemains'];
      if (remainsOffer !== undefined && remainsOffer !== 1) {
        return invalid(type, 'Invalid world remains capability');
      }
      const rawToken = message['resumeToken'] ?? payload['resumeToken'];
      if (
        snapshotOffer !== SNAPSHOT_VERSION ||
        asteroidInteractionsOffer !== ASTEROID_INTERACTIONS_CAPABILITY
      ) {
        return invalid(type, 'Client update required; refresh GeoRoids');
      }
      const position = readJoinPosition(fields['position']);
      if (!position) {
        return invalid(type, 'Join position is outside the world or invalid');
      }
      const clientReleaseId = readReleaseId(
        message['clientReleaseId'] ?? payload['clientReleaseId']
      );
      return {
        ok: true,
        command: {
          type,
          id,
          name,
          position,
          ...(isShipKitId(kitOffer) ? { kitId: kitOffer } : {}),
          resumeRequested: rawToken !== undefined,
          ...(payload['cooperativeVersion'] === 1 ? { cooperativeVersion: 1 as const } : {}),
          ...(remainsOffer === 1 ? { worldRemains: 1 } : {}),

          ...(typeof rawToken === 'string' ? { resumeToken: rawToken } : {}),
          ...(clientReleaseId != null && clientReleaseId !== '' ? { clientReleaseId } : {}),
        },
      };
    }
    case 'snapshotAck': {
      const sequence = readSafeInteger(fields['sequence']);
      return sequence !== undefined && sequence > 0
        ? { ok: true, command: { type, sequence } }
        : invalid(type, 'Invalid applied snapshot acknowledgment');
    }
    case 'leave':
    case 'snapshotResync':
      return { ok: true, command: { type } };
    case 'ping': {
      const probeId = message['probeId'];
      if (
        probeId !== undefined &&
        (typeof probeId !== 'number' || !Number.isSafeInteger(probeId) || probeId < 1)
      ) {
        return { ok: false, error: 'Invalid ping probeId' };
      }
      return { ok: true, command: { type, ...(typeof probeId === 'number' ? { probeId } : {}) } };
    }
    case 'update':
      return decodeUpdate(id, fields);
    case 'crewAction': {
      if (!id) {
        return invalid(type, 'Missing crew action owner');
      }
      const kind = fields['kind'];
      if (kind === 'release' || kind === 'give-up' || kind === 'withdraw-supply') {
        return { ok: true, command: { type, id, action: { kind } } };
      }
      if (kind === 'revive') {
        const targetId = readNonEmptyString(fields['targetId']);
        return targetId != null && targetId !== '' && targetId.length <= 128
          ? { ok: true, command: { type, id, action: { kind, targetId } } }
          : invalid(type, 'Invalid rescue target');
      }
      const signal = fields['signal'];
      const position = readFinitePosition(fields['position']);
      return kind === 'signal' &&
        (signal === 'help' || signal === 'nest') &&
        position &&
        Math.hypot(position.x, position.y) <= WORLD.radius
        ? { ok: true, command: { type, id, action: { kind, signal, position } } }
        : invalid(type, 'Invalid crew signal');
    }
    case 'useAbility':
      return decodeUseAbility(id);
    case 'chargeWeapon': {
      const action = fields['action'];
      return id && (action === 'start' || action === 'release' || action === 'cancel')
        ? { ok: true, command: { type, id, action } }
        : invalid(type, 'Invalid charge action');
    }
    case 'travelFurnace': {
      const destinationId = fields['destinationId'];
      return id &&
        typeof destinationId === 'string' &&
        destinationId.length > 0 &&
        destinationId.length <= 128
        ? { ok: true, command: { type, id, destinationId } }
        : invalid(type, 'Invalid furnace travel request');
    }
    case 'equipSatellite': {
      const pickupId = fields['pickupId'];
      return id && typeof pickupId === 'string' && pickupId.length > 0 && pickupId.length <= 128
        ? { ok: true, command: { type, id, pickupId } }
        : invalid(type, 'Invalid satellite equipment request');
    }
    case 'setHaulerUtility': {
      if (!id) {
        return invalid(type, 'Missing player ID for setHaulerUtility');
      }
      const utilityId = fields['utilityId'];
      return isHaulerUtilityId(utilityId)
        ? { ok: true, command: { type, id, utilityId } }
        : invalid(type, 'Invalid Hauler utility');
    }
    case 'setScoutUtility': {
      if (!id) {
        return invalid(type, 'Missing player ID for setScoutUtility');
      }
      const utilityId = fields['utilityId'];
      return isScoutUtilityId(utilityId)
        ? { ok: true, command: { type, id, utilityId } }
        : invalid(type, 'Invalid Scout utility');
    }
    case 'buyStoreItem': {
      if (!id) {
        return invalid(type, 'Missing player ID for buyStoreItem');
      }
      const offerId = fields['offerId'];
      return typeof offerId === 'string' && storeOffer(offerId)
        ? { ok: true, command: { type, id, offerId } }
        : invalid(type, 'Invalid store offer');
    }
    case 'shoot': {
      if (!id) {
        return invalid(type, 'Missing player ID for shoot');
      }
      const rawRequestId = fields['requestId'];
      if (
        rawRequestId !== undefined &&
        (typeof rawRequestId !== 'string' ||
          rawRequestId.length < 1 ||
          rawRequestId.length > 64 ||
          !SHOT_REQUEST_ID_PATTERN.test(rawRequestId))
      ) {
        return invalid(type, 'Invalid shoot request ID');
      }
      const laserStart = readFinitePosition(fields['laserStart']);
      const laserDirection = readFinitePosition(fields['laserDirection']);
      return laserStart && laserDirection
        ? {
            ok: true,
            command: {
              type,
              id,
              laserStart,
              laserDirection,
              ...(typeof rawRequestId === 'string' ? { requestId: rawRequestId } : {}),
            },
          }
        : invalid(type, 'Missing finite laser coordinates for shoot');
    }
    default:
      return {
        ok: false,
        messageType: type,
        error: `Unknown message type: ${type}`,
        logUnknown: true,
      };
  }
}
