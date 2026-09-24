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
    let projectileSeen = false;
    let socketError;
    let state;
    let joinedId;
    const expectedSocket = new URL(healthUrl);
    expectedSocket.protocol = 'wss:';
    expectedSocket.pathname = '/ws';
    page.on('websocket', (socket) => {
      const url = new URL(socket.url());
      if (url.pathname !== '/ws') {
        return;
      }
      const observed = { url: socket.url(), serverReleaseId: null, admitted: false };
      evidence.sockets.push(observed);
      if (url.protocol !== 'wss:' || url.host !== expectedSocket.host) {
        socketError = new Error(`Unexpected gameplay WebSocket: ${socket.url()}`);
        return;
      }
      const decoder = new SnapshotDecoder();
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
            if (decoded.message?.type !== 'joined') {
              return;
            }
            const data = decoded.message.data;
            observed.serverReleaseId = data?.serverReleaseId;
            verifyAncestry(minimum, observed.serverReleaseId);
            assert.equal(data.snapshotVersion, 1, 'Unsupported joined snapshot protocol');
            assert.equal(data.asteroidInteractions, 1, 'Missing asteroid protocol admission');
            assert.ok(typeof data.id === 'string' && data.id.length, 'Missing joined player ID');
            joinedId = data.id;
            observed.admitted = true;
            return;
          }
          state = decoded.state;
          snapshots++;
          evidence.acceptedSnapshots = snapshots;
          if (
            playerId &&
            state.playerProjectiles.some((projectile) => projectile.ownerId === playerId)
          ) {
            projectileSeen = true;
          }
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
        joinedId === playerId &&
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
    await page.keyboard.down('Space');
    try {
      await waitForEvidence(() => {
        assert.ifError(socketError);
        return projectileSeen;
      }, 'owned projectile after firing');
    } finally {
      await page.keyboard.up('Space');
    }
    await checkHealth();
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
