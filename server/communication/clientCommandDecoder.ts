import { readReleaseId } from '../../shared/releaseId';
import { WORLD } from '../../shared/world';
import type {
  HaulerUtilityId,
  PingMessage,
  Position,
  ShipKitId,
  SurveyorUtilityId,
  Velocity,
} from '../../shared-types';
import { isHaulerUtilityId } from '../../src/entities/ship/haulerUtility';
import { isShipKitId } from '../../src/entities/ship/shipKits';
import { isSurveyorUtilityId } from '../../src/entities/ship/surveyorUtility';

type WireRecord = Record<string, unknown>;

const SHOT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface PlayerMovementUpdate {
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  thrusting?: boolean;
  boosting?: boolean;
  boostDepleted?: boolean;
  angularVelocity?: number;
  overlayHold?: boolean;
}

export type ClientCommand =
  | {
      type: 'join';
      id: string;
      name: string;
      position: Position;
      kitId?: ShipKitId;
      snapshotVersion: 1;
      asteroidInteractions: 1;
      resumeRequested: boolean;
      resumeToken?: string;
      clientReleaseId?: string;
    }
  | { type: 'equipSatellite'; id: string; pickupId: string }
  | { type: 'leave' }
  | { type: 'snapshotResync' }
  | {
      type: 'useAbility';
      id: string;
      kitId?: ShipKitId;
      abilityId?: string;
    }
  | {
      type: 'setHaulerUtility';
      id: string;
      utilityId: HaulerUtilityId;
    }
  | {
      type: 'setSurveyorUtility';
      id: string;
      utilityId: SurveyorUtilityId;
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
  | { type: 'chat'; id: string; message: string }
  | { type: 'collisionDamage'; targetPlayerId: string; attackerId: string }
  | { type: 'initAsteroids'; id: string }
  | { type: 'clientLog'; payload: WireRecord }
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
  const rawAngularVelocity = fields['angularVelocity'];
  const rawThrusting = fields['thrusting'];
  const rawBoosting = fields['boosting'];
  const rawBoostDepleted = fields['boostDepleted'];
  const rawOverlayHold = fields['overlayHold'];
  const position = readFinitePosition(rawPosition);
  const velocity = readFinitePosition(rawVelocity);
  const angle = readFiniteNumber(rawAngle);
  const angularVelocity = readFiniteNumber(rawAngularVelocity);
  const thrusting = typeof rawThrusting === 'boolean' ? rawThrusting : undefined;
  const boosting = typeof rawBoosting === 'boolean' ? rawBoosting : undefined;
  const boostDepleted = typeof rawBoostDepleted === 'boolean' ? rawBoostDepleted : undefined;

  if (
    !id ||
    (rawPosition !== undefined && position === undefined) ||
    (rawVelocity !== undefined && velocity === undefined) ||
    (rawAngle !== undefined && angle === undefined) ||
    (rawAngularVelocity !== undefined && angularVelocity === undefined) ||
    (rawThrusting !== undefined && thrusting === undefined) ||
    (rawBoosting !== undefined && boosting === undefined) ||
    (rawBoostDepleted !== undefined && boostDepleted === undefined) ||
    (rawOverlayHold !== undefined && typeof rawOverlayHold !== 'boolean')
  ) {
    return invalid('update', !id ? 'Missing player ID' : 'Invalid player movement update');
  }

  const update: PlayerMovementUpdate = {
    ...(position !== undefined ? { position } : {}),
    ...(velocity !== undefined ? { velocity } : {}),
    ...(angle !== undefined ? { angle } : {}),
    ...(thrusting !== undefined ? { thrusting } : {}),
    ...(boosting !== undefined ? { boosting } : {}),
    ...(boostDepleted !== undefined ? { boostDepleted } : {}),
    ...(angularVelocity !== undefined ? { angularVelocity } : {}),
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

function decodeUseAbility(id: string, fields: WireRecord): ClientCommandDecodeResult {
  const playerId = id ? id : (readString(fields['id']) ?? '');
  if (!playerId) {
    return invalid('useAbility', 'Missing player ID for useAbility');
  }
  const rawKitId = fields['kitId'];
  if (rawKitId !== undefined && !isShipKitId(rawKitId)) {
    return invalid('useAbility');
  }
  const abilityId = readString(fields['abilityId']);
  return {
    ok: true,
    command: {
      type: 'useAbility',
      id: playerId,
      ...(rawKitId !== undefined ? { kitId: rawKitId } : {}),
      ...(abilityId !== undefined ? { abilityId } : {}),
    },
  };
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
      const rawToken = message['resumeToken'] ?? payload['resumeToken'];
      if (snapshotOffer !== 1 || asteroidInteractionsOffer !== 1) {
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
          snapshotVersion: 1,
          asteroidInteractions: 1,
          resumeRequested: rawToken !== undefined,
          ...(typeof rawToken === 'string' ? { resumeToken: rawToken } : {}),
          ...(clientReleaseId ? { clientReleaseId } : {}),
        },
      };
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
    case 'clientLog':
      return { ok: true, command: { type, payload } };
    case 'update':
      return decodeUpdate(id, fields);
    case 'useAbility':
      return decodeUseAbility(id, fields);
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
    case 'setSurveyorUtility': {
      if (!id) {
        return invalid(type, 'Missing player ID for setSurveyorUtility');
      }
      const utilityId = fields['utilityId'];
      return isSurveyorUtilityId(utilityId)
        ? { ok: true, command: { type, id, utilityId } }
        : invalid(type, 'Invalid Surveyor utility');
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
    case 'chat': {
      if (!id || typeof fields['message'] !== 'string') {
        return invalid(type, 'Missing player ID or message');
      }
      const chatMessage = fields['message'].trim();
      return chatMessage && chatMessage.length <= 500
        ? { ok: true, command: { type, id, message: chatMessage } }
        : invalid(type, 'Chat message must be between 1 and 500 characters');
    }
    case 'collisionDamage': {
      const targetPlayerId = readNonEmptyString(fields['targetPlayerId']);
      const attackerId = readNonEmptyString(fields['attackerId']);
      return targetPlayerId && attackerId
        ? { ok: true, command: { type, targetPlayerId, attackerId } }
        : invalid(type, 'Missing required fields for collisionDamage');
    }
    case 'initAsteroids':
      return id
        ? { ok: true, command: { type, id } }
        : invalid(type, 'Missing player ID for initAsteroids');
    default:
      return {
        ok: false,
        messageType: type,
        error: `Unknown message type: ${type}`,
        logUnknown: true,
      };
  }
}
