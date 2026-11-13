import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { EXPLORATION_VERSION } from '../../shared/atlasTransport';
import {
  ASTEROID_INTERACTIONS_CAPABILITY,
  SNAPSHOT_VERSION,
  SnapshotDecoder,
} from '../../shared/snapshotProtocol';
import { createServerInstance } from '../createServer';
import { createSnapshot, inspectSnapshot, type SnapshotReceipt } from './snapshot';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Boots an expendable copy on loopback only. The downloaded artifact stays unchanged. */
export async function rehearseRestore(options: {
  artifact: string;
  expectedSha256: string;
  scratchDirectory: string;
}): Promise<{
  artifact: SnapshotReceipt;
  boot: true;
  join: true;
  movement: true;
  firing: true;
  persistence: true;
}> {
  if (!isAbsolute(options.artifact) || !isAbsolute(options.scratchDirectory)) {
    throw new Error('Restore requires absolute artifact and new scratch paths');
  }
  const receipt = await inspectSnapshot(options.artifact);
  if (receipt.sha256 !== options.expectedSha256 || !isAbsolute(options.scratchDirectory)) {
    throw new Error('Restore requires exact reviewed SHA256 and an absolute new scratch directory');
  }
  const source = new DatabaseSync(options.artifact, { readOnly: true });
  let seed: number;
  try {
    const value = source
      .prepare("SELECT json_extract(json,'$.seed') AS seed FROM world WHERE id=1")
      .get()?.['seed'];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Restore world seed is invalid');
    }
    seed = value;
  } finally {
    source.close();
  }
  // Exclusive mkdir prevents overwriting a volume or an existing rehearsal.
  await mkdir(options.scratchDirectory, { mode: 0o700 });
  let server: ReturnType<typeof createServerInstance> | undefined;
  let socket: WebSocket | undefined;
  try {
    const path = join(options.scratchDirectory, 'rehearsal.sqlite');
    await createSnapshot(options.artifact, path);
    server = createServerInstance({
      port: 0,
      host: '127.0.0.1',
      nodeEnv: 'test',
      worldPath: path,
      debugReports: false,
    });
    const port = await server.listening;
    server.gameEngine.stopGameLoop();
    if (server.gameEngine.getTerrainSeed() !== seed || !server.gameEngine.isPersistenceHealthy()) {
      throw new Error('Restored world did not boot with retained seed and healthy persistence');
    }
    const engine = server.gameEngine;
    const id = `drill-${randomUUID()}`;
    const decoder = new SnapshotDecoder('live');
    let joinedAccepted = false;
    socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?snapshotVersion=${SNAPSHOT_VERSION}&asteroidInteractions=${ASTEROID_INTERACTIONS_CAPABILITY}&explorationVersion=${EXPLORATION_VERSION}`
    );
    const connection = socket;
    function send(type: string, data: Record<string, unknown>): void {
      connection.send(JSON.stringify({ type, data }));
    }
    function waitFor(
      read: (value: ReturnType<SnapshotDecoder['readMessage']>) => boolean,
      trigger: () => void
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => finish(new Error('Restore gameplay contract timed out')),
          5000
        );
        const failed = () => finish(new Error('Restore gameplay transport failed'));
        const received = (raw: WebSocket.RawData) => {
          try {
            const value = decoder.readMessage(String(raw), {
              acceptSnapshots: joinedAccepted,
            });
            if (value.kind === 'snapshot-rejected') {
              throw value.error;
            }
            if (value.kind === 'snapshot') {
              send('snapshotAck', { sequence: value.metadata.sequence });
            }
            if (read(value)) {
              finish();
            }
          } catch {
            finish(new Error('Restore gameplay message failed validation'));
          }
        };
        function finish(error?: Error): void {
          clearTimeout(deadline);
          connection.off('message', received);
          connection.off('error', failed);
          connection.off('close', failed);
          error ? reject(error) : resolve();
        }
        connection.on('message', received);
        connection.once('error', failed);
        connection.once('close', failed);
        trigger();
      });
    }
    await new Promise<void>((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });
    await waitFor(
      (value) => {
        const accepted =
          value.kind === 'message' &&
          record(value.message) &&
          value.message['type'] === 'joined' &&
          record(value.message['data']) &&
          value.message['data']['id'] === id &&
          value.message['data']['terrainSeed'] === seed &&
          value.message['data']['snapshotVersion'] === SNAPSHOT_VERSION &&
          value.message['data']['asteroidInteractions'] === ASTEROID_INTERACTIONS_CAPABILITY &&
          value.message['data']['explorationVersion'] === EXPLORATION_VERSION;
        if (accepted) {
          decoder.reset();
          joinedAccepted = true;
        }
        return accepted;
      },
      () =>
        send('join', {
          id,
          name: id,
          position: { x: 0, y: 0 },
          kitId: 'scout',
          snapshotVersion: SNAPSHOT_VERSION,
          asteroidInteractions: ASTEROID_INTERACTIONS_CAPABILITY,
          explorationVersion: EXPLORATION_VERSION,
          cooperativeVersion: 1,
        })
    );
    const actor = engine.getPlayer(id);
    if (!actor?.playerMotion) {
      throw new Error('Restored server refused join');
    }
    const target = { x: actor.position.x + 1, y: actor.position.y };
    await waitFor(
      (value) =>
        value.kind === 'snapshot' &&
        value.state.entities.some(
          (entity) =>
            entity.id === id && entity.playerMotion?.ack === 1 && entity.position.x === target.x
        ),
      () => {
        send('update', {
          id,
          position: target,
          velocity: { x: 0, y: 0 },
          angle: actor.angle,
          thrusting: false,
          contourLock: null,
          motionEpoch: actor.playerMotion?.epoch,
          motionSequence: 1,
        });
        send('snapshotResync', {});
      }
    );
    if (engine.getPlayer(id)?.position.x !== target.x) {
      throw new Error('Restored server refused movement');
    }
    await waitFor(
      (value) => {
        if (!record(value) || value['kind'] !== 'message' || !record(value['message'])) {
          return false;
        }
        const message = value['message'];
        return (
          message['type'] === 'shotAcknowledged' &&
          record(message['data']) &&
          message['data']['requestId'] === 'restore-drill' &&
          typeof message['data']['projectileId'] === 'string'
        );
      },
      () =>
        send('shoot', {
          id,
          laserStart: target,
          laserDirection: { x: 1, y: 0 },
          requestId: 'restore-drill',
        })
    );
    connection.terminate();
    await server.close();
    server = undefined;
    // Graceful close flushes the synthetic pilot through the real worker writer.
    const after = await inspectSnapshot(path);
    if (after.pilots !== receipt.pilots + 1) {
      throw new Error('Restored checkpoint did not retain the drill pilot');
    }
    if ((await inspectSnapshot(options.artifact)).sha256 !== receipt.sha256) {
      throw new Error('Original artifact changed during rehearsal');
    }
    return {
      artifact: receipt,
      boot: true,
      join: true,
      movement: true,
      firing: true,
      persistence: true,
    };
  } finally {
    socket?.terminate();
    try {
      await server?.close();
    } finally {
      await rm(options.scratchDirectory, { recursive: true, force: true });
    }
  }
}
