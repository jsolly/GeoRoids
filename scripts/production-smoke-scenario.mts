import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { clientAssetGraph, clientDocumentAssets } from './client-asset-graph.ts';
import type { runNetworkSmoke } from './production-smoke-network.mts';
import {
  requireEvidence,
  SmokeFailure,
  smokeCause,
  smokeClock,
} from './production-smoke-network.mts';

export const productionUrl = 'https://www.georoids.com/';
const healthUrl = 'https://georoids-production-2403.up.railway.app/health';
// tsImport retains the existing runtime loader without emitting the shared game graph.
// Its return value enters as unknown; validate only the capabilities consumed here.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const protocol: unknown = await tsImport('../shared/snapshotProtocol.ts', import.meta.url);
requireEvidence(isRecord(protocol), 'Local snapshot protocol module is malformed');
const capability = protocol['ASTEROID_INTERACTIONS_CAPABILITY'];
const snapshotVersion = protocol['SNAPSHOT_VERSION'];
const Decoder = protocol['SnapshotDecoder'];
requireEvidence(
  typeof capability === 'number' &&
    typeof snapshotVersion === 'number' &&
    typeof Decoder === 'function',
  'Local snapshot protocol capabilities are unavailable'
);
const ASTEROID_INTERACTIONS_CAPABILITY = capability;
const SNAPSHOT_VERSION = snapshotVersion;
const DecoderClass = Decoder;
const socketUrl = `wss://georoids-production-2403.up.railway.app/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=${ASTEROID_INTERACTIONS_CAPABILITY}`;
const gameplay: unknown = await tsImport('../shared/constants/gameplay.ts', import.meta.url);
requireEvidence(isRecord(gameplay), 'Local gameplay constants are malformed');
const game = gameplay['GAME'];
const laser = gameplay['LASER'];
requireEvidence(isRecord(game) && isRecord(laser), 'Local gameplay constants are unavailable');
function hasNumericProperty<Key extends string>(
  value: Record<string, unknown>,
  key: Key
): value is Record<string, unknown> & Record<Key, number> {
  return typeof value[key] === 'number';
}
requireEvidence(
  hasNumericProperty(game, 'FPS') && hasNumericProperty(laser, 'SPEED'),
  'Local gameplay motion constants are unavailable'
);
// Preserve the original live constant objects rather than copying their numeric values.
const GAME = game;
const LASER = laser;

type NetworkOptions = Parameters<typeof runNetworkSmoke>[0];
type NetworkContext = Parameters<NetworkOptions['scenario']['smoke']>[0];
type Clock = NonNullable<NetworkOptions['clock']>;
type Timer = ReturnType<Clock['setTimeout']>;
type VerifyHttp = NetworkContext['verifyHttp'];
interface ClientReadiness {
  verifyHttp: VerifyHttp;
  clock?: Clock;
  signal?: AbortSignal | undefined;
  readinessMs?: number;
  pollMs?: number;
}
interface SmokeOptions {
  expectedSha: string | undefined;
  verifyHttp: VerifyHttp;
  artifacts?: string | null;
  observations?: NetworkContext['observations'];
  createSocket?: NetworkContext['createSocket'];
  clock?: Clock;
  signal?: AbortSignal | undefined;
  clientReadinessMs?: number;
  clientPollMs?: number;
}
interface Vector2 {
  x: number;
  y: number;
}
type SmokeCommand =
  | { type: 'snapshotAck'; data: { sequence: number } }
  | {
      type: 'join';
      id: string;
      data: {
        name: string;
        position: Vector2;
        kitId: 'scout';
        snapshotVersion: number;
        asteroidInteractions: number;
        cooperativeVersion: 1;
        clientReleaseId: string | undefined;
      };
    }
  | {
      type: 'update';
      id: string;
      data: {
        position: Vector2;
        velocity: Vector2;
        angle: number;
        thrusting: false;
        contourLock: null;
        overlayHold: false;
        motionEpoch: number;
        motionSequence: number;
      };
    }
  | {
      type: 'shoot';
      id: string;
      data: { laserStart: Vector2; laserDirection: Vector2; requestId: string };
    };
interface MotionPilot {
  id: string;
  health: number;
  exploding: unknown;
  position: { x: number; y: number };
  angle: number;
  playerMotion: { epoch: number; ack: number };
}
function motionPilot(value: unknown): value is MotionPilot {
  if (!isRecord(value)) {
    return false;
  }
  const position = value['position'];
  const motion = value['playerMotion'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['health'] === 'number' &&
    typeof value['angle'] === 'number' &&
    isRecord(position) &&
    typeof position['x'] === 'number' &&
    typeof position['y'] === 'number' &&
    isRecord(motion) &&
    typeof motion['epoch'] === 'number' &&
    typeof motion['ack'] === 'number'
  );
}
interface Evidence {
  serverReleaseId: unknown;
  acceptedSnapshots: number;
  admission: { playerId: string; snapshotVersion: number; asteroidInteractions: number } | null;
  movement: { epoch: number; sequence: number; acknowledged: number; displacement: number } | null;
  shot: { requestId: string; projectileId: string | null; acknowledged: boolean } | null;
  socketClosed: boolean;
  closeCode: number | null;
  error?: string;
  cleanupError?: string;
}
function createDecoder(): {
  readMessage(text: string, admission: { acceptSnapshots: boolean }): unknown;
} {
  const decoder: unknown = Reflect.construct(DecoderClass, []);
  requireEvidence(isRecord(decoder), 'Local snapshot decoder is malformed');
  const read = decoder['readMessage'];
  requireEvidence(typeof read === 'function', 'Local snapshot decoder cannot read messages');
  return {
    readMessage(text, admission): unknown {
      const decoded: unknown = Reflect.apply(read, decoder, [text, admission]);
      return decoded;
    },
  };
}

function documentAssets(html: string): { modules: string[]; assets: string[] } {
  requireEvidence(
    /<html\b/iu.test(html) && /<canvas\b[^>]*\bid=["']gameCanvas["']/iu.test(html),
    'Published client document is malformed'
  );
  const { modules, assets } = clientDocumentAssets(html);
  return {
    modules: modules.map((path) => new URL(`/${path}`, productionUrl).href),
    assets: assets.map((path) => new URL(`/${path}`, productionUrl).href),
  };
}

export async function waitForClientAssets({
  verifyHttp,
  clock = smokeClock,
  signal,
  readinessMs = 120000,
  pollMs = 5000,
}: ClientReadiness): Promise<{ assetCount: number }> {
  const deadline = clock.now() + readinessMs;
  for (;;) {
    try {
      signal?.throwIfAborted();
      const document = await verifyHttp(productionUrl);
      requireEvidence(
        /^text\/html\b/iu.test(document.headers.get('content-type') ?? ''),
        'Client document content type is invalid'
      );
      const { modules, assets: documentFiles } = documentAssets(await document.text());
      const attributed = await (
        await verifyHttp(new URL('/client-assets.json', productionUrl).href)
      ).json();
      const reachable = clientAssetGraph(
        attributed,
        modules.map((url) => new URL(url).pathname.slice(1))
      );
      const assets = [
        ...new Set([
          ...documentFiles,
          ...reachable.map((path) => new URL(path, productionUrl).href),
        ]),
      ];
      for (const url of assets) {
        const response = await verifyHttp(url);
        const javascript = url.endsWith('.js');
        requireEvidence(
          javascript
            ? /^(?:application|text)\/javascript\b/iu.test(
                response.headers.get('content-type') ?? ''
              )
            : /^text\/css\b/iu.test(response.headers.get('content-type') ?? ''),
          'Client bundle asset content type is invalid'
        );
        const body = await response.text();
        requireEvidence(body.length > 0, 'Client bundle asset is empty');
      }
      return { assetCount: assets.length };
    } catch (error) {
      signal?.throwIfAborted();
      if (clock.now() >= deadline) {
        throw new SmokeFailure(
          error instanceof SmokeFailure
            ? `Client asset readiness deadline: ${error.message}`
            : 'Client asset readiness deadline',
          { cause: error }
        );
      }
      await clock.sleep(Math.min(pollMs, deadline - clock.now()), signal);
    }
  }
}

async function waitForEvidence(
  predicate: () => unknown,
  description: string,
  { clock, signal }: { clock: Clock; signal?: AbortSignal | undefined }
): Promise<void> {
  const deadline = clock.now() + 10000;
  const ready = (): boolean => Boolean(predicate());
  while (!ready()) {
    signal?.throwIfAborted();
    requireEvidence(clock.now() < deadline, `Missing authoritative ${description}`);
    await clock.sleep(Math.min(50, deadline - clock.now()), signal);
  }
}

export async function smoke({
  expectedSha,
  verifyHttp,
  artifacts,
  observations = [],
  createSocket = (url, options) => new WebSocket(url, options),
  clock = smokeClock,
  signal,
  clientReadinessMs = 120000,
  clientPollMs = 5000,
}: SmokeOptions): Promise<void> {
  const client = await waitForClientAssets({
    verifyHttp,
    clock,
    signal,
    readinessMs: clientReadinessMs,
    pollMs: clientPollMs,
  });
  observations.push({ source: 'client-assets', ...client });
  const evidence: Evidence = {
    serverReleaseId: null,
    acceptedSnapshots: 0,
    admission: null,
    movement: null,
    shot: null,
    socketClosed: false,
    closeCode: null,
  };
  let outcomeFailure: unknown;
  let socket: ReturnType<NonNullable<NetworkContext['createSocket']>> | undefined;
  let closing = false;
  let admitted = false;
  let state: { entities: unknown[] } | undefined;
  let wireFailure: SmokeFailure | undefined;
  let closeResolve: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    closeResolve = resolveClosed;
  });
  const pilotId = `smoke-${randomUUID()}`,
    shotRequestId = randomUUID();
  const decoder = createDecoder();
  let movementSequence: number;
  let movementEpoch: number;
  const checkHealth = async () => {
    const health: unknown = await (await verifyHttp(healthUrl)).json();
    if (health === null || health === undefined) {
      throw new TypeError('Malformed production health data');
    }
    const healthFields = isRecord(health) ? health : undefined;
    const world = healthFields?.['world'];
    const persistence = isRecord(world) ? world['persistence'] : undefined;
    const loop = isRecord(world) ? world['loop'] : undefined;
    requireEvidence(
      isRecord(persistence) && persistence['mode'] === 'worker',
      'Persistent world worker is required'
    );
    requireEvidence(persistence['failed'] === false, 'Persistent world worker failed');
    requireEvidence(isRecord(loop) && loop['stalls'] === 0, 'Game loop has stalled');
    observations.push({
      source: 'server-health',
      releaseSha: healthFields?.['releaseId'],
      persistenceMode: 'worker',
      persistenceFailed: false,
      stalls: 0,
    });
  };
  const checkWire = () => {
    if (wireFailure) {
      throw wireFailure;
    }
    signal?.throwIfAborted();
  };
  const send = (message: SmokeCommand): void => {
    checkWire();
    requireEvidence(
      socket !== undefined && socket.readyState === WebSocket.OPEN,
      'Gameplay socket is not open'
    );
    socket.send(JSON.stringify(message));
  };
  const player = (): Record<string, unknown> | undefined =>
    state?.entities.find(
      (entity): entity is Record<string, unknown> => isRecord(entity) && entity['id'] === pilotId
    );
  const abort = () => {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      closing = true;
      socket.terminate();
    }
  };
  try {
    await checkHealth();
    socket = createSocket(socketUrl, {
      origin: new URL(productionUrl).origin,
      handshakeTimeout: 15000,
      maxPayload: 1024 * 1024,
    });
    socket.on('error', (error) => {
      wireFailure ??= new SmokeFailure('Gameplay socket transport failed', {
        cause: smokeCause(error),
      });
    });
    socket.on('close', (code) => {
      evidence.socketClosed = true;
      evidence.closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null;
      if (!closing) {
        wireFailure ??= new SmokeFailure('Gameplay socket closed before verification');
      }
      closeResolve();
    });
    socket.on('open', () => {
      try {
        send({
          type: 'join',
          id: pilotId,
          data: {
            name: `Smoke${pilotId.slice(-12)}`,
            position: { x: 0, y: 0 },
            kitId: 'scout',
            snapshotVersion: SNAPSHOT_VERSION,
            asteroidInteractions: ASTEROID_INTERACTIONS_CAPABILITY,
            cooperativeVersion: 1,
            clientReleaseId: expectedSha,
          },
        });
      } catch (error) {
        wireFailure ??= new SmokeFailure('Gameplay join could not be sent', {
          cause: smokeCause(error),
        });
      }
    });
    socket.on('message', (payload) => {
      if (closing) {
        return;
      }
      try {
        const decoded = decoder.readMessage(
          typeof payload === 'string'
            ? payload
            : Buffer.isBuffer(payload)
              ? payload.toString('utf8')
              : payload.toString(),
          { acceptSnapshots: admitted }
        );
        requireEvidence(isRecord(decoded), 'Malformed gameplay protocol message');
        if (decoded['kind'] === 'snapshot-rejected') {
          throw new SmokeFailure('Gameplay snapshot failed current protocol validation', {
            cause: decoded['error'],
          });
        }
        if (decoded['kind'] === 'snapshot') {
          const snapshot = decoded['state'];
          const metadata = decoded['metadata'];
          requireEvidence(
            isRecord(snapshot) &&
              Array.isArray(snapshot['entities']) &&
              isRecord(metadata) &&
              typeof metadata['sequence'] === 'number',
            'Malformed gameplay protocol message'
          );
          state = { entities: snapshot['entities'] };
          evidence.acceptedSnapshots++;
          send({ type: 'snapshotAck', data: { sequence: metadata['sequence'] } });
          return;
        }
        const message = decoded['message'];
        if (!isRecord(message)) {
          return;
        }
        const data = message['data'];
        if (message['type'] === 'joined') {
          requireEvidence(
            !admitted &&
              isRecord(data) &&
              data['id'] === pilotId &&
              data['snapshotVersion'] === SNAPSHOT_VERSION &&
              data['asteroidInteractions'] === ASTEROID_INTERACTIONS_CAPABILITY &&
              typeof data['resumeToken'] === 'string' &&
              data['resumeToken'].length > 0,
            'Gameplay join admission is incomplete or mismatched'
          );
          evidence.serverReleaseId = data['serverReleaseId'] ?? null;
          admitted = true;
          evidence.admission = {
            playerId: pilotId,
            snapshotVersion: SNAPSHOT_VERSION,
            asteroidInteractions: ASTEROID_INTERACTIONS_CAPABILITY,
          };
        } else if (message['type'] === 'shotAcknowledged') {
          requireEvidence(
            isRecord(data) &&
              typeof data['requestId'] === 'string' &&
              (data['projectileId'] === null ||
                (typeof data['projectileId'] === 'string' && data['projectileId'].length > 0)),
            'Malformed authoritative shot acknowledgement'
          );
          if (evidence.shot != null && data['requestId'] === shotRequestId) {
            requireEvidence(
              data['projectileId'] !== null,
              'Authoritative server rejected the smoke shot'
            );
            evidence.shot.projectileId = data['projectileId'];
            evidence.shot.acknowledged = true;
          }
        } else if (message['type'] === 'error' || message['type'] === 'sessionExpired') {
          throw new SmokeFailure('Authoritative server rejected gameplay admission or command');
        }
      } catch (error) {
        wireFailure ??=
          error instanceof SmokeFailure
            ? error
            : new SmokeFailure('Malformed gameplay protocol message', {
                // JSON.parse diagnostics can embed a private socket payload.
                cause:
                  error instanceof SyntaxError
                    ? new Error('Gameplay JSON parsing failed')
                    : smokeCause(error),
              });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    await waitForEvidence(
      () => {
        checkWire();
        return admitted && evidence.acceptedSnapshots >= 2 && player();
      },
      'join and snapshots',
      { clock, signal }
    );
    // Allow normal server-time travel credit, then use the latest authoritative
    // epoch and ack. The snapshot must acknowledge this exact submitted pose.
    await clock.sleep(250, signal);
    checkWire();
    const initial = player();
    const exploding = Boolean(initial?.['exploding']);
    requireEvidence(
      motionPilot(initial) &&
        initial.health > 0 &&
        !exploding &&
        Number.isSafeInteger(initial.playerMotion?.epoch) &&
        Number.isSafeInteger(initial.playerMotion?.ack),
      'Current pilot motion admission is missing'
    );
    movementEpoch = initial.playerMotion.epoch;
    movementSequence = initial.playerMotion.ack + 1;
    requireEvidence(
      Number.isSafeInteger(movementSequence),
      'Motion acknowledgement sequence overflowed'
    );
    const origin = { ...initial.position },
      initialAngle = initial.angle;
    const position = { x: origin.x + 6, y: origin.y };
    const angle = Math.atan2(Math.sin(initialAngle + 0.02), Math.cos(initialAngle + 0.02));
    send({
      type: 'update',
      id: pilotId,
      data: {
        position,
        velocity: { x: 0, y: 0 },
        angle,
        thrusting: false,
        contourLock: null,
        overlayHold: false,
        motionEpoch: movementEpoch,
        motionSequence: movementSequence,
      },
    });
    await waitForEvidence(
      () => {
        checkWire();
        const current = player();
        if (!motionPilot(current)) {
          return false;
        }
        return (
          current.playerMotion.epoch === movementEpoch &&
          current.playerMotion.ack >= movementSequence &&
          Math.hypot(current.position.x - origin.x, current.position.y - origin.y) > 5 &&
          Math.hypot(current.position.x - position.x, current.position.y - position.y) < 0.2 &&
          Math.abs(
            Math.atan2(
              Math.sin(current.angle - initialAngle),
              Math.cos(current.angle - initialAngle)
            )
          ) > 0.01
        );
      },
      'acknowledged ship movement',
      { clock, signal }
    );
    const accepted = player();
    requireEvidence(motionPilot(accepted), 'Current pilot motion admission is missing');
    evidence.movement = {
      epoch: movementEpoch,
      sequence: movementSequence,
      acknowledged: accepted.playerMotion.ack,
      displacement: Math.hypot(accepted.position.x - origin.x, accepted.position.y - origin.y),
    };
    const current = accepted;
    evidence.shot = { requestId: shotRequestId, projectileId: null, acknowledged: false };
    send({
      type: 'shoot',
      id: pilotId,
      data: {
        laserStart: { ...current.position },
        laserDirection: { x: LASER['SPEED'] / GAME['FPS'], y: 0 },
        requestId: shotRequestId,
      },
    });
    await waitForEvidence(
      () => {
        checkWire();
        return evidence.shot?.acknowledged;
      },
      'accepted shot acknowledgement',
      { clock, signal }
    );
    await checkHealth();
    checkWire();
    observations.push({
      source: 'authoritative-gameplay',
      acceptedSnapshots: evidence.acceptedSnapshots,
      motionEpoch: movementEpoch,
      motionSequence: movementSequence,
      acceptedShot: true,
    });
  } catch (error) {
    evidence.error =
      error instanceof SmokeFailure ? error.message : 'Production gameplay verification failed';
    outcomeFailure = error;
  } finally {
    let cleanupFailure: SmokeFailure | undefined;
    try {
      signal?.removeEventListener('abort', abort);
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        closing = true;
        let graceTimer: Timer | undefined;
        let closeTimer: Timer | undefined;
        const timeout = new Promise<never>((_, reject) => {
          closeTimer = clock.setTimeout(() => {
            reject(new SmokeFailure('Owned gameplay socket close was not observed'));
          }, 10000);
          graceTimer = clock.setTimeout(() => {
            cleanupFailure = new SmokeFailure('Owned gameplay socket required forced termination');
            socket?.terminate();
          }, 9000);
        });
        try {
          try {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'leave' }));
              socket.close(1000, 'Smoke complete');
            } else {
              socket?.terminate();
            }
          } catch (error) {
            cleanupFailure = new SmokeFailure('Owned gameplay socket cleanup failed', {
              cause: smokeCause(error),
            });
            socket?.terminate();
          }
          await Promise.race([closed, timeout]);
        } finally {
          clock.clearTimeout(graceTimer);
          clock.clearTimeout(closeTimer);
        }
      }
      if (socket) {
        requireEvidence(evidence.socketClosed, 'Owned gameplay socket close was not observed');
        if (!cleanupFailure) {
          requireEvidence(evidence.closeCode === 1000, 'Owned gameplay socket closed abnormally');
        }
      }
    } catch (error) {
      cleanupFailure =
        error instanceof SmokeFailure
          ? error
          : new SmokeFailure('Owned gameplay socket cleanup failed', { cause: smokeCause(error) });
      evidence.cleanupError = cleanupFailure.message;
    }
    if (cleanupFailure) {
      evidence.cleanupError = cleanupFailure.message;
    }
    outcomeFailure ??= wireFailure;
    const errorRecorded = Boolean(evidence.error);
    if (wireFailure && !errorRecorded) {
      evidence.error = wireFailure.message;
    }
    const artifactDirectory = artifacts ?? '';
    const retainArtifacts = Boolean(artifactDirectory);
    if (retainArtifacts) {
      await writeFile(
        join(artifactDirectory, 'gameplay-server.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      );
    }
    outcomeFailure ??= cleanupFailure;
  }
  const failed = Boolean(outcomeFailure);
  if (failed) {
    throw outcomeFailure;
  }
}
