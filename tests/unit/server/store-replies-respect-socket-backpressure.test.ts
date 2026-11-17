/* @vitest-environment node */
import { afterEach, expect, test } from 'vitest';
import { WebSocketCore } from '../../../server/communication/WebSocketCore';
import { GameEngine } from '../../../server/core/GameEngine';
import { SNAPSHOT_BACKPRESSURE_BYTES, SNAPSHOT_VERSION } from '../../../shared/snapshotProtocol';
import { STORE_OFFERS } from '../../../shared/townStore';
import { RecordingSocket } from '../../support/recordingSocket';

let engine: GameEngine | undefined;
let core: WebSocketCore | undefined;

afterEach(() => {
  core?.stopPeriodicGameStateBroadcast();
  engine?.stopGameLoop();
  core = undefined;
  engine = undefined;
});

test('a store reply on a backed-up socket closes it for recovery instead of growing the queue', () => {
  engine = new GameEngine(5);
  core = new WebSocketCore(engine);
  const socket = new RecordingSocket();
  const closes: number[] = [];
  socket.on('close', (code: number) => closes.push(code));
  core.handleClientMessage(
    {
      type: 'join',
      data: {
        id: 'shopper',
        name: 'Shopper',
        position: { x: 0, y: 0 },
        snapshotVersion: SNAPSHOT_VERSION,
        asteroidInteractions: 1,
        explorationVersion: 1,
      },
    },
    socket
  );
  const purchase = { type: 'buyStoreItem', id: 'shopper', data: { offerId: STORE_OFFERS[0].id } };
  core.handleClientMessage(purchase, socket);
  expect(socket.received('townStoreResult')).toHaveLength(1);

  const sent = socket.sent.length;
  socket.bufferedAmount = SNAPSHOT_BACKPRESSURE_BYTES + 1;
  core.handleClientMessage(purchase, socket);
  expect(socket.sent).toHaveLength(sent);
  expect(closes).toEqual([1013]);
});
