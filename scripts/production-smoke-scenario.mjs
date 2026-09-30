import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import { minimumServerRelease } from './server-release-inputs.mjs';

export const productionUrl = 'https://www.georoids.com/';
const { SnapshotDecoder } = await tsImport('../shared/snapshotProtocol.ts', import.meta.url);
const healthUrl = 'https://georoids-production-2403.up.railway.app/health';

async function waitForEvidence(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Missing authoritative ${description}`);
    }
    await delay(50);
  }
}

export async function smoke({
  page,
  expectedSha,
  expectedServerSha,
  verifyRelease,
  artifacts,
  verifyAncestry,
}) {
  const minimum = expectedServerSha || minimumServerRelease(expectedSha);
  const checkHealth = async () => {
    const response = await verifyRelease(healthUrl, minimum);
    const health = await response.json();
    assert.equal(health.world?.persistence?.mode, 'worker', 'Persistent world worker is required');
    assert.equal(health.world?.persistence?.failed, false, 'Persistent world worker failed');
    assert.equal(health.world?.loop?.stalls, 0, 'Game loop has stalled');
  };
  const evidence = { minimumServerRelease: minimum, sockets: [], acceptedSnapshots: 0 };
  try {
    await checkHealth();
    let snapshots = 0;
    let playerId;
    let firing = false;
    let acceptedShot = false;
    let activeSocket;
    let activeAdmission;
    let socketError;
    let state;

    const expectedSocket = new URL(healthUrl);
    expectedSocket.protocol = 'wss:';
    expectedSocket.pathname = '/ws';
    page.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname !== '/ws') {
        return;
      }
      const observed = {
        url: socket.url(),
        serverReleaseId: null,
        admitted: false,
        playerId: null,
        shots: [],
      };
      const requests = new Map();
      evidence.sockets.push(observed);
      if (url.protocol !== 'wss:' || url.host !== expectedSocket.host) {
        socketError = new Error(`Unexpected gameplay WebSocket: ${socket.url()}`);
        return;
      }
      const decoder = new SnapshotDecoder();
      socket.on('framesent', ({ payload }) => {
        if (!firing || socket !== activeSocket || !observed.admitted) {
          return;
        }
        try {
          const message = JSON.parse(typeof payload === 'string' ? payload : payload.toString());
          if (message.type !== 'shoot') {
            return;
          }
          const data = message.data;
          assert.equal(message.id, playerId, 'Shoot request belongs to another player');
          assert.equal(
            message.id,
            observed.playerId,
            'Shoot request differs from socket admission'
          );
          assert.ok(
            typeof data.requestId === 'string' && data.requestId.length,
            'Missing shoot request ID'
          );
          assert.ok(!requests.has(data.requestId), 'Duplicate shoot request ID');
          const shot = { playerId: message.id, requestId: data.requestId, projectileId: null };
          requests.set(data.requestId, shot);
          observed.shots.push(shot);
        } catch (error) {
          socketError = error;
          observed.error = String(error);
        }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const decoded = decoder.readMessage(
            typeof payload === 'string' ? payload : payload.toString(),
            { acceptSnapshots: observed.admitted }
          );
          if (decoded.kind === 'snapshot-rejected') {
            throw decoded.error;
          }
          if (decoded.kind === 'message') {
            if (decoded.message?.type === 'shotAcknowledged') {
              const data = decoded.message.data;
              assert.ok(
                typeof data?.requestId === 'string' && data.requestId.length,
                'Malformed shot acknowledgement request ID'
              );
              assert.ok(
                data.projectileId === null ||
                  (typeof data.projectileId === 'string' && data.projectileId.length),
                'Malformed shot acknowledgement projectile ID'
              );
              const shot = requests.get(data.requestId);
              if (
                firing &&
                socket === activeSocket &&
                observed.playerId === playerId &&
                shot &&
                data.projectileId !== null
              ) {
                shot.projectileId = data.projectileId;
                acceptedShot = true;
              }
              return;
            }
            if (decoded.message?.type !== 'joined') {
              return;
            }
            const data = decoded.message.data;
            observed.serverReleaseId = data?.serverReleaseId;
            verifyAncestry(minimum, observed.serverReleaseId);
            assert.equal(data.snapshotVersion, 1, 'Unsupported joined snapshot protocol');
            assert.equal(data.asteroidInteractions, 1, 'Missing asteroid protocol admission');
            assert.ok(typeof data.id === 'string' && data.id.length, 'Missing joined player ID');
            observed.playerId = data.id;
            activeSocket = socket;
            activeAdmission = observed;
            state = undefined;
            snapshots = 0;
            observed.admitted = true;
            return;
          }
          if (socket !== activeSocket) {
            return;
          }
          state = decoded.state;
          snapshots++;
          evidence.acceptedSnapshots = snapshots;
        } catch (error) {
          socketError = error;
          observed.error = String(error);
        }
      });
    });
    await page
      .getByLabel('Your Nickname', { exact: true })
      .fill(`Smoke${randomUUID().slice(0, 12)}`);
    await page.getByRole('button', { name: 'Enter Game', exact: true }).click();
    await page.waitForFunction(() =>
      Boolean(window.gameController?.getNetworkManager().getLocalPlayerId())
    );
    playerId = await page.evaluate(() =>
      window.gameController.getNetworkManager().getLocalPlayerId()
    );
    await waitForEvidence(() => {
      assert.ifError(socketError);
      return (
        snapshots >= 2 &&
        activeAdmission?.admitted &&
        activeAdmission.playerId === playerId &&
        state?.entities.some((entity) => entity.id === playerId)
      );
    }, 'join and snapshots');
    const player = () => state.entities.find((entity) => entity.id === playerId);
    assert.ifError(socketError);
    const initial = { ...player().position };
    const initialAngle = player().angle;
    await page.keyboard.down('ArrowRight');
    try {
      await waitForEvidence(() => {
        const position = player()?.position;
        assert.ifError(socketError);
        return (
          position &&
          Math.hypot(position.x - initial.x, position.y - initial.y) > 5 &&
          Math.abs(player().angle - initialAngle) > 0.01
        );
      }, 'ship movement');
    } finally {
      await page.keyboard.up('ArrowRight');
    }
    firing = true;
    try {
      await page.keyboard.down('Space');
      await waitForEvidence(() => {
        assert.ifError(socketError);
        return acceptedShot;
      }, 'accepted shot acknowledgement after firing');
    } finally {
      firing = false;
      await page.keyboard.up('Space');
    }
    await checkHealth();
    assert.ifError(socketError);
  } catch (error) {
    evidence.error = String(error);
    throw error;
  } finally {
    if (artifacts) {
      await writeFile(
        join(artifacts, 'gameplay-server.json'),
        `${JSON.stringify(evidence, null, 2)}\n`
      );
    }
  }
}
