import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { clientAssetGraph, clientDocumentAssets } from './client-asset-graph.mjs';
import { requireEvidence, SmokeFailure, smokeClock } from './production-smoke-network.mjs';

export const productionUrl = 'https://www.georoids.com/';
const healthUrl = 'https://georoids-production-2403.up.railway.app/health';
const socketUrl =
  'wss://georoids-production-2403.up.railway.app/ws?snapshotVersion=3&asteroidInteractions=1';
const { SNAPSHOT_VERSION, SnapshotDecoder } = await tsImport(
  '../shared/snapshotProtocol.ts',
  import.meta.url
);
const { GAME, LASER } = await tsImport('../src/constants/index.ts', import.meta.url);

function documentAssets(html) {
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
}) {
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

async function waitForEvidence(predicate, description, { clock, signal }) {
  const deadline = clock.now() + 10000;
  while (!predicate()) {
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
}) {
  const client = await waitForClientAssets({
    verifyHttp,
    clock,
    signal,
    readinessMs: clientReadinessMs,
    pollMs: clientPollMs,
  });
  observations.push({ source: 'client-assets', ...client });
  const evidence = {
    serverReleaseId: null,
    acceptedSnapshots: 0,
    admission: null,
    movement: null,
    shot: null,
    socketClosed: false,
    closeCode: null,
  };
  let outcomeFailure;
  let socket,
    closing = false,
    admitted = false,
    state,
    wireFailure;
  let closeResolve;
  const closed = new Promise((resolveClosed) => {
    closeResolve = resolveClosed;
  });
  const pilotId = `smoke-${randomUUID()}`,
    shotRequestId = randomUUID();
  const decoder = new SnapshotDecoder();
  let movementSequence, movementEpoch;
  const checkHealth = async () => {
    const health = await (await verifyHttp(healthUrl)).json();
    requireEvidence(
      health.world?.persistence?.mode === 'worker',
      'Persistent world worker is required'
    );
    requireEvidence(health.world?.persistence?.failed === false, 'Persistent world worker failed');
    requireEvidence(health.world?.loop?.stalls === 0, 'Game loop has stalled');
    observations.push({
      source: 'server-health',
      releaseSha: health.releaseId,
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
  const send = (message) => {
    checkWire();
    requireEvidence(socket.readyState === WebSocket.OPEN, 'Gameplay socket is not open');
    socket.send(JSON.stringify(message));
  };
  const player = () => state?.entities.find((entity) => entity.id === pilotId);
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
    socket.on('error', () => {
      wireFailure ??= new SmokeFailure('Gameplay socket transport failed');
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
            asteroidInteractions: 1,
            clientReleaseId: expectedSha,
          },
        });
      } catch {
        wireFailure ??= new SmokeFailure('Gameplay join could not be sent');
      }
    });
    socket.on('message', (payload) => {
      if (closing) {
        return;
      }
      try {
        const decoded = decoder.readMessage(
          typeof payload === 'string' ? payload : payload.toString('utf8'),
          { acceptSnapshots: admitted }
        );
        if (decoded.kind === 'snapshot-rejected') {
          throw new SmokeFailure('Gameplay snapshot failed current protocol validation');
        }
        if (decoded.kind === 'snapshot') {
          state = decoded.state;
          evidence.acceptedSnapshots++;
          send({ type: 'snapshotAck', data: { sequence: decoded.metadata.sequence } });
          return;
        }
        const message = decoded.message;
        if (message?.type === 'joined') {
          requireEvidence(
            !admitted &&
              message.data?.id === pilotId &&
              message.data?.snapshotVersion === SNAPSHOT_VERSION &&
              message.data?.asteroidInteractions === 1 &&
              message.data?.shotAcknowledgements === true &&
              typeof message.data?.resumeToken === 'string' &&
              message.data.resumeToken.length > 0,
            'Gameplay join admission is incomplete or mismatched'
          );
          evidence.serverReleaseId = message.data.serverReleaseId ?? null;
          admitted = true;
          evidence.admission = {
            playerId: pilotId,
            snapshotVersion: SNAPSHOT_VERSION,
            asteroidInteractions: 1,
            shotAcknowledgements: true,
          };
        } else if (message?.type === 'shotAcknowledged') {
          requireEvidence(
            typeof message.data?.requestId === 'string' &&
              (message.data.projectileId === null ||
                (typeof message.data.projectileId === 'string' &&
                  message.data.projectileId.length > 0)),
            'Malformed authoritative shot acknowledgement'
          );
          if (evidence.shot && message.data.requestId === shotRequestId) {
            requireEvidence(
              message.data.projectileId !== null,
              'Authoritative server rejected the smoke shot'
            );
            evidence.shot.projectileId = message.data.projectileId;
            evidence.shot.acknowledged = true;
          }
        } else if (message?.type === 'error' || message?.type === 'sessionExpired') {
          throw new SmokeFailure('Authoritative server rejected gameplay admission or command');
        }
      } catch (error) {
        wireFailure ??=
          error instanceof SmokeFailure
            ? error
            : new SmokeFailure('Malformed gameplay protocol message');
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
    requireEvidence(
      initial?.health > 0 &&
        !initial.exploding &&
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
        return (
          current?.playerMotion?.epoch === movementEpoch &&
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
    evidence.movement = {
      epoch: movementEpoch,
      sequence: movementSequence,
      acknowledged: player().playerMotion.ack,
      displacement: Math.hypot(player().position.x - origin.x, player().position.y - origin.y),
    };
    const current = player();
    evidence.shot = { requestId: shotRequestId, projectileId: null, acknowledged: false };
    send({
      type: 'shoot',
      id: pilotId,
      data: {
        laserStart: { ...current.position },
        laserDirection: { x: LASER.SPEED / GAME.FPS, y: 0 },
        requestId: shotRequestId,
      },
    });
    await waitForEvidence(
      () => {
        checkWire();
        return evidence.shot.acknowledged;
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
    let cleanupFailure;
    try {
      signal?.removeEventListener('abort', abort);
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        closing = true;
        let graceTimer, closeTimer;
        const timeout = new Promise((_, reject) => {
          closeTimer = clock.setTimeout(() => {
            reject(new SmokeFailure('Owned gameplay socket close was not observed'));
          }, 10000);
          graceTimer = clock.setTimeout(() => {
            cleanupFailure = new SmokeFailure('Owned gameplay socket required forced termination');
            socket.terminate();
          }, 9000);
        });
        try {
          try {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'leave' }));
              socket.close(1000, 'Smoke complete');
            } else {
              socket.terminate();
            }
          } catch {
            cleanupFailure = new SmokeFailure('Owned gameplay socket cleanup failed');
            socket.terminate();
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
          : new SmokeFailure('Owned gameplay socket cleanup failed');
      evidence.cleanupError = cleanupFailure.message;
    }
    if (cleanupFailure) {
      evidence.cleanupError = cleanupFailure.message;
    }
    outcomeFailure ??= wireFailure;
    if (wireFailure && !evidence.error) {
      evidence.error = wireFailure.message;
    }
    if (artifacts) {
      await writeFile(
        join(artifacts, 'gameplay-server.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      );
    }
    outcomeFailure ??= cleanupFailure;
  }
  if (outcomeFailure) {
    throw outcomeFailure;
  }
}
