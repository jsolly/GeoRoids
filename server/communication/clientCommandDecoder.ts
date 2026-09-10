import type {
  AsteroidMotionInput,
  AsteroidToolAction,
  Position,
  ShipKitId,
  SoftFactionId,
  Velocity,
} from '../../shared-types';
import { parseSoftFactionId } from '../../src/entities/player/softFactions';
import { isShipKitId } from '../../src/entities/ship/shipKits';

type WireRecord = Record<string, unknown>;

interface PlayerMovementUpdate {
  position?: Position;
  velocity?: Velocity;
  angle?: number;
  thrusting?: boolean;
  angularVelocity?: number;
}

export type ClientCommand =
  | {
      type: 'join';
      id: string;
      name: string;
      position: Position;
      kitId?: ShipKitId;
      factionId?: SoftFactionId;
      snapshotVersion: 1;
      asteroidInteractions: 1;
      resumeRequested: boolean;
      resumeToken?: string;
    }
  | { type: 'leave' }
  | { type: 'asteroidTool'; action: AsteroidToolAction }
  | { type: 'asteroidInput'; input: AsteroidMotionInput }
  | { type: 'snapshotResync' }
  | {
      type: 'useAbility';
      id: string;
      kitId?: ShipKitId;
      abilityId?: string;
      latchView: { playfieldScale?: number; canvas?: { width: number; height: number } };
    }
  | {
      type: 'update';
      id: string;
      update: PlayerMovementUpdate;
      motionEpoch?: number;
      motionSequence?: number;
    }
  | { type: 'shoot'; id: string; laserStart: Position; laserDirection: Velocity }
  | { type: 'shield'; id: string; active: boolean }
  | { type: 'chat'; id: string; message: string }
  | { type: 'collisionDamage'; targetPlayerId: string; attackerId: string }
  | { type: 'satellitePickupCollected'; pickupId: string; claimedPlayerId?: string }
  | { type: 'initAsteroids'; id: string }
  | { type: 'clientLog'; payload: WireRecord }
  | { type: 'ping' };

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

function readJoinPosition(value: unknown): Position {
  if (!isRecord(value)) {
    return { x: 0, y: 0 };
  }
  const rawX = value['x'];
  const rawY = value['y'];
  const x = typeof rawX === 'number' ? rawX : typeof rawX === 'string' ? parseFloat(rawX) : NaN;
  const y = typeof rawY === 'number' ? rawY : typeof rawY === 'string' ? parseFloat(rawY) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : { x: 0, y: 0 };
}

function invalid(messageType: string, error?: string): ClientCommandDecodeResult {
  return {
    ok: false,
    messageType,
    ...(error !== undefined ? { error } : {}),
  };
}

function decodeAsteroidTool(payload: WireRecord): ClientCommandDecodeResult {
  const sequence = readSafeInteger(payload['sequence']);
  const targetId = payload['targetId'];
  if (
    payload['action'] !== 'latch' ||
    sequence === undefined ||
    (targetId !== undefined && typeof targetId !== 'string')
  ) {
    return invalid('asteroidTool', 'Unsupported asteroid tool action');
  }
  return {
    ok: true,
    command: {
      type: 'asteroidTool',
      action: {
        action: 'latch',
        sequence,
        ...(targetId !== undefined ? { targetId } : {}),
      },
    },
  };
}

function decodeAsteroidInput(payload: WireRecord): ClientCommandDecodeResult {
  const epoch = readSafeInteger(payload['epoch']);
  const sequence = readSafeInteger(payload['sequence']);
  const thrust = payload['thrust'];
  const turn = payload['turn'];
  const aimAngle = readFiniteNumber(payload['aimAngle']);
  const rawAction = payload['action'];
  const action =
    rawAction === 'release' ||
    rawAction === 'anchor' ||
    rawAction === 'brake' ||
    rawAction === 'spin'
      ? rawAction
      : undefined;
  const targetId = payload['targetId'];
  if (
    epoch === undefined ||
    sequence === undefined ||
    typeof thrust !== 'boolean' ||
    (turn !== -1 && turn !== 0 && turn !== 1) ||
    aimAngle === undefined ||
    (rawAction !== undefined && action === undefined) ||
    (targetId !== undefined && typeof targetId !== 'string')
  ) {
    return invalid('asteroidInput');
  }
  return {
    ok: true,
    command: {
      type: 'asteroidInput',
      input: {
        epoch,
        sequence,
        thrust,
        turn,
        aimAngle,
        ...(action !== undefined ? { action } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
      },
    },
  };
}

function decodeUpdate(id: string, fields: WireRecord): ClientCommandDecodeResult {
  const rawPosition = fields['position'];
  const rawVelocity = fields['velocity'];
  const rawAngle = fields['angle'];
  const rawAngularVelocity = fields['angularVelocity'];
  const rawThrusting = fields['thrusting'];
  const position = readFinitePosition(rawPosition);
  const velocity = readFinitePosition(rawVelocity);
  const angle = readFiniteNumber(rawAngle);
  const angularVelocity = readFiniteNumber(rawAngularVelocity);
  const thrusting = typeof rawThrusting === 'boolean' ? rawThrusting : undefined;

  if (
    !id ||
    (rawPosition !== undefined && position === undefined) ||
    (rawVelocity !== undefined && velocity === undefined) ||
    (rawAngle !== undefined && angle === undefined) ||
    (rawAngularVelocity !== undefined && angularVelocity === undefined) ||
    (rawThrusting !== undefined && thrusting === undefined)
  ) {
    return invalid('update', !id ? 'Missing player ID' : 'Invalid player movement update');
  }

  const update: PlayerMovementUpdate = {
    ...(position !== undefined ? { position } : {}),
    ...(velocity !== undefined ? { velocity } : {}),
    ...(angle !== undefined ? { angle } : {}),
    ...(thrusting !== undefined ? { thrusting } : {}),
    ...(angularVelocity !== undefined ? { angularVelocity } : {}),
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
  const playerId = id || readString(fields['id']) || '';
  if (!playerId) {
    return invalid('useAbility', 'Missing player ID for useAbility');
  }
  const rawKitId = fields['kitId'];
  if (rawKitId !== undefined && !isShipKitId(rawKitId)) {
    return invalid('useAbility');
  }
  const canvasWidth = Number(fields['canvasWidth']);
  const canvasHeight = Number(fields['canvasHeight']);
  const playfieldScale = Number(fields['playfieldScale']);
  const abilityId = readString(fields['abilityId']);
  return {
    ok: true,
    command: {
      type: 'useAbility',
      id: playerId,
      ...(rawKitId !== undefined ? { kitId: rawKitId } : {}),
      ...(abilityId !== undefined ? { abilityId } : {}),
      latchView: {
        ...(Number.isFinite(playfieldScale) && playfieldScale > 0 ? { playfieldScale } : {}),
        ...(Number.isFinite(canvasWidth) &&
        Number.isFinite(canvasHeight) &&
        canvasWidth > 0 &&
        canvasHeight > 0
          ? { canvas: { width: canvasWidth, height: canvasHeight } }
          : {}),
      },
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
      const factionOffer = message['factionId'] ?? payload['factionId'];
      const snapshotOffer = message['snapshotVersion'] ?? payload['snapshotVersion'];
      const asteroidInteractionsOffer =
        message['asteroidInteractions'] ?? payload['asteroidInteractions'];
      const rawToken = message['resumeToken'] ?? payload['resumeToken'];
      if (snapshotOffer !== 1 || asteroidInteractionsOffer !== 1) {
        return invalid(type, 'Client update required; refresh GeoRoids');
      }
      return {
        ok: true,
        command: {
          type,
          id,
          name,
          position: readJoinPosition(fields['position']),
          ...(isShipKitId(kitOffer) ? { kitId: kitOffer } : {}),
          ...(() => {
            const factionId = parseSoftFactionId(factionOffer);
            return factionId === undefined ? {} : { factionId };
          })(),
          snapshotVersion: 1,
          asteroidInteractions: 1,
          resumeRequested: rawToken !== undefined,
          ...(typeof rawToken === 'string' ? { resumeToken: rawToken } : {}),
        },
      };
    }
    case 'leave':
    case 'snapshotResync':
    case 'ping':
      return { ok: true, command: { type } };
    case 'asteroidTool':
      return decodeAsteroidTool(payload);
    case 'asteroidInput':
      return decodeAsteroidInput(payload);
    case 'clientLog':
      return { ok: true, command: { type, payload } };
    case 'update':
      return decodeUpdate(id, fields);
    case 'useAbility':
      return decodeUseAbility(id, fields);
    case 'shoot': {
      if (!id) {
        return invalid(type, 'Missing player ID for shoot');
      }
      const laserStart = readFinitePosition(fields['laserStart']);
      const laserDirection = readFinitePosition(fields['laserDirection']);
      return laserStart && laserDirection
        ? { ok: true, command: { type, id, laserStart, laserDirection } }
        : invalid(type, 'Missing finite laser coordinates for shoot');
    }
    case 'shield':
      if (!id) {
        return invalid(type, 'Missing player ID for shield');
      }
      return typeof fields['active'] === 'boolean'
        ? { ok: true, command: { type, id, active: fields['active'] } }
        : invalid(type, 'Missing active flag for shield');
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
      const damage = readFiniteNumber(fields['damage']);
      return targetPlayerId && attackerId && damage !== undefined
        ? { ok: true, command: { type, targetPlayerId, attackerId } }
        : invalid(type, 'Missing required fields for collisionDamage');
    }
    case 'satellitePickupCollected': {
      const pickupId = readNonEmptyString(fields['pickupId']);
      if (!pickupId) {
        return invalid(type, 'Missing pickup ID for satellitePickupCollected');
      }
      const claimed = fields['playerId'];
      return claimed === undefined || typeof claimed === 'string'
        ? {
            ok: true,
            command: {
              type,
              pickupId,
              ...(claimed !== undefined ? { claimedPlayerId: claimed } : {}),
            },
          }
        : invalid(type);
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
