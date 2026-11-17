/* @vitest-environment node */
import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import {
  ATLAS_SEGMENT_BYTES,
  type AtlasCursor,
  AtlasReceiver,
  offerAtlas,
} from '../../../shared/atlasTransport';
import { ExplorationMap, explorationCellAt, isCellExplored } from '../../../shared/exploration';
import type { SnapshotBaseline } from '../../../shared/snapshotProtocol';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import { RecordingSocket } from '../../support/recordingSocket';
import { snapshotFixture } from './snapshotFixture';

function source(count = 1200): ExplorationMap {
  const map = new ExplorationMap();
  map.restore(
    Array.from({ length: count }, (_, slot) => ({
      id: `${slot % 60},${Math.floor(slot / 60)}`,
      bits: `01${'00'.repeat(31)}`,
    }))
  );
  return map;
}

test('a bounded live baseline catches mutations behind its cursor and beyond its captured end', () => {
  const map = source();
  const receiver = new AtlasReceiver();
  let cursor: AtlasCursor = { kind: 'start' };
  const first = offerAtlas(map, cursor, 1);
  assert(first);
  receiver.prepare(first.segment)();
  cursor = first.next;
  const target = map.atlasIdentity().revision;
  map.reveal({ x: -59_812.5, y: -59_937.5 }, 1);
  map.reveal({ x: 58_187.5, y: -21_937.5 }, 1);
  map.reveal({ x: -59_937.5, y: -17_937.5 }, 1);
  let completion = 0;
  for (let step = 0; step < 128; step++) {
    const offer = offerAtlas(map, cursor, 1);
    if (!offer) {
      break;
    }
    expect(Buffer.byteLength(offer.text)).toBeLessThanOrEqual(ATLAS_SEGMENT_BYTES);
    if (offer.segment.through !== null && completion === 0) {
      completion = offer.segment.through;
    }
    receiver.prepare(offer.segment)();
    cursor = offer.next;
  }
  expect(completion).toBe(target);
  expect(receiver.isSyncing()).toBe(false);
  expect(receiver.snapshot()).toEqual(map.snapshot());
  expect(offerAtlas(map, cursor, 1)).toBeUndefined();
});

test('long accepted IDs replay partially, retain exact identity, and stay isolated from consumers', () => {
  const map = new ExplorationMap();
  const id = `${'0'.repeat(20_000)}1,0`;
  const bits = `01${'00'.repeat(31)}`;
  map.restore([{ id, bits }]);
  const receiver = new AtlasReceiver();
  const first = offerAtlas(map, { kind: 'start' }, 1);
  assert(first && first.segment.through === null);
  receiver.prepare(first.segment)();
  receiver.prepare({ ...first.segment, reset: false })();
  let cursor = first.next;
  for (let step = 0; step < 32; step++) {
    const offer = offerAtlas(map, cursor, 1);
    if (!offer) {
      break;
    }
    expect(Buffer.byteLength(offer.text)).toBeLessThanOrEqual(ATLAS_SEGMENT_BYTES);
    receiver.prepare(offer.segment)();
    cursor = offer.next;
  }
  expect(receiver.snapshot()).toEqual([{ id, bits }]);
  const view = receiver.snapshot();
  const tile = view[0];
  assert(tile);
  tile.bits = 'ff'.repeat(32);
  expect(receiver.snapshot()).toEqual([{ id, bits }]);
  const cell = explorationCellAt({ x: -57_937.5, y: -59_937.5 });
  assert(cell !== null);
  expect(isCellExplored(receiver.snapshot(), cell)).toBe(false);
});

test('malformed atlas work cannot advance the accepted world baseline or clear the old atlas', () => {
  const { exploration: _atlas, ...world } = snapshotFixture();
  const map = source(2);
  const decoder = new SnapshotDecoder('live');
  const firstEncoder = new SnapshotEncoder(world, undefined, 'live');
  const firstOffer = offerAtlas(map, { kind: 'start' }, 1);
  assert(firstOffer);
  const first = decoder.readMessage(
    firstEncoder.encodeSerialized(1, undefined, 0, firstOffer).text,
    { acceptSnapshots: true }
  );
  assert(first.kind === 'snapshot');
  const second = new SnapshotEncoder({ ...world, gameTime: 1 }, undefined, 'live');
  const baseline: SnapshotBaseline = { sequence: 1, state: firstEncoder.state };
  const frame = second.encode(2, baseline);
  const bad = {
    ...firstOffer.segment,
    reset: true,
    records: [{ kind: 'tile', slot: 0, offset: 5, total: 8, id: '1,0', bits: 'ff'.repeat(32) }],
  };
  expect(
    decoder.readMessage(JSON.stringify({ type: 'snapshot', data: { ...frame, atlas: bad } }), {
      acceptSnapshots: true,
    }).kind
  ).toBe('snapshot-rejected');
  const repaired = decoder.readMessage(second.encodeSerialized(2, baseline, 0).text, {
    acceptSnapshots: true,
  });
  assert(repaired.kind === 'snapshot');
  expect(repaired.state.exploration).toEqual(first.state.exploration);
  expect(repaired.state.gameTime).toBe(1);
});

test('reset, a new join with repeated process epoch, and explicit loss replace atlas authority', () => {
  const map = source(1);
  const receiver = new AtlasReceiver();
  const initial = offerAtlas(map, { kind: 'start' }, 1);
  assert(initial);
  receiver.prepare(initial.segment)();
  map.reset();
  const reset = offerAtlas(map, initial.next, 2);
  assert(reset);
  receiver.prepare(reset.segment)();
  expect(receiver.snapshot()).toEqual([]);
  const other = source(1);
  const otherInitial = offerAtlas(other, { kind: 'start' }, 1);
  assert(otherInitial);
  receiver.reset();
  receiver.prepare(otherInitial.segment)();
  expect(receiver.snapshot()).toEqual(other.snapshot());
  expect(() => receiver.prepare({ ...otherInitial.segment, transfer: 0 })).toThrow('Stale atlas');
});

test('two recipients recover independently without a hidden complete-atlas read or unchanged-map index work', () => {
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const left = new RecordingSocket();
  const right = new RecordingSocket();
  try {
    engine.addPlayer('left', 'Left', left, { x: 0, y: 0 });
    engine.addPlayer('right', 'Right', right, { x: 0, y: 0 });
    broadcaster.negotiateSnapshot(left);
    broadcaster.negotiateSnapshot(right);
    const snapshot = vi.spyOn(ExplorationMap.prototype, 'snapshot').mockImplementation(() => {
      throw new Error('Full atlas reached broadcast');
    });
    const query = vi.spyOn(ExplorationMap.prototype, 'nextAtlasTile');
    const leftDecoder = new SnapshotDecoder('live');
    const rightDecoder = new SnapshotDecoder('live');
    const apply = (socket: RecordingSocket, decoder: SnapshotDecoder, acknowledge = true) => {
      const raw = socket.sent.at(-1);
      assert(raw);
      const result = decoder.readMessage(raw, { acceptSnapshots: true });
      assert(result.kind === 'snapshot');
      if (acknowledge) {
        expect(broadcaster.acknowledgeSnapshot(socket, result.metadata.sequence)).toBe(true);
      }
      return result;
    };
    broadcaster.broadcastGameState();
    const firstLeft = apply(left, leftDecoder);
    const firstRight = apply(right, rightDecoder, false);
    query.mockClear();
    broadcaster.requestSnapshotKeyframe(left, { recovery: true });
    broadcaster.broadcastGameState();
    expect(apply(left, leftDecoder).state.exploration).toEqual(firstLeft.state.exploration);
    expect(query).not.toHaveBeenCalled();
    expect(left.sent.at(-1)).not.toContain('"atlas":');
    expect(broadcaster.acknowledgeSnapshot(right, firstRight.metadata.sequence)).toBe(true);
    expect(broadcaster.acknowledgeSnapshot(left, 100_000)).toBe(false);
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    engine.stopGameLoop();
  }
});

test('legacy snapshot identity and restored extension properties survive additive map indexing', () => {
  const map = new ExplorationMap();
  const tile = { id: '00,0', bits: '00'.repeat(32), future: { kept: true } };
  map.restore([tile]);
  const cached = map.snapshot();
  expect(cached).toEqual([tile]);
  offerAtlas(map, { kind: 'start' }, 1);
  expect(map.snapshot()).toBe(cached);
  expect(map.atlasIdentity().encodedBytes).toBe(
    JSON.stringify([{ id: tile.id, bits: tile.bits }]).length
  );
  map.reveal({ x: -59_937.5, y: -59_937.5 }, 1);
  expect(map.snapshot()).not.toBe(cached);
  expect(cached).toEqual([tile]);
});

test('missing or unsupported atlas joins fail before creating or resuming any pilot', () => {
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const handler = new MessageHandler(engine, broadcaster);
  const resume = vi.spyOn(engine.pilotSessions, 'resume');
  try {
    for (const offer of [undefined, 0, 2]) {
      const socket = new RecordingSocket();
      handler.handleMessage(
        {
          type: 'join',
          id: 'unsupported',
          data: {
            name: 'Unsupported',
            snapshotVersion: 3,
            asteroidInteractions: 1,
            explorationVersion: offer,
            resumeToken: 'a'.repeat(64),
          },
        },
        socket
      );
      expect(engine.getPlayerCount()).toBe(0);
      expect(socket.received('joined')).toHaveLength(0);
      expect(socket.received('error')).toHaveLength(1);
    }
    expect(resume).not.toHaveBeenCalled();
    expect(() => new SnapshotEncoder(snapshotFixture(), undefined, 'live')).toThrow(
      'live snapshot DTO'
    );
  } finally {
    vi.restoreAllMocks();
    engine.stopGameLoop();
  }
});

test('an early ACK waits for its callback and an older callback cannot install a rejoined atlas cursor', () => {
  const engine = new GameEngine(82);
  const broadcaster = new GameStateBroadcaster(engine);
  const socket = new RecordingSocket();
  const pending: Array<(error?: Error) => void> = [];
  try {
    engine.createAsteroids(0);
    engine.addPlayer('pending', 'Pending', socket, { x: 0, y: 0 });
    broadcaster.negotiateSnapshot(socket);
    const original = socket.send.bind(socket);
    vi.spyOn(socket, 'send').mockImplementation((data, options, callback) => {
      if (typeof options === 'object') {
        throw new Error('Unexpected send options');
      }
      original(data);
      const done = options ?? callback;
      if (done) {
        pending.push(done);
      }
    });
    const decoder = new SnapshotDecoder('live');
    const apply = () => {
      const raw = socket.sent.at(-1);
      assert(raw);
      const result = decoder.readMessage(raw, { acceptSnapshots: true });
      assert(result.kind === 'snapshot');
      expect(broadcaster.acknowledgeSnapshot(socket, result.metadata.sequence)).toBe(true);
      return result;
    };
    broadcaster.broadcastGameState();
    const first = apply();
    const count = socket.sent.length;
    broadcaster.broadcastGameState();
    expect(socket.sent).toHaveLength(count);
    broadcaster.negotiateSnapshot(socket);
    const oldCallback = pending.shift();
    assert(oldCallback);
    oldCallback();
    decoder.reset();
    broadcaster.broadcastGameState();
    expect(socket.sent.at(-1)).toContain('"atlas":');
    expect(apply().state.exploration).toEqual(first.state.exploration);
    const currentCallback = pending.shift();
    assert(currentCallback);
    currentCallback();
    broadcaster.requestSnapshotKeyframe(socket, { recovery: true });
    broadcaster.broadcastGameState();
    expect(socket.sent.at(-1)).not.toContain('"atlas":');
    apply();
    const recoveryCallback = pending.shift();
    assert(recoveryCallback);
    recoveryCallback();
  } finally {
    vi.restoreAllMocks();
    engine.stopGameLoop();
  }
});

test('a failed atlas-bearing send closes without acknowledging its offered chart', () => {
  const engine = new GameEngine(82);
  const socket = new RecordingSocket();
  const broadcaster = new GameStateBroadcaster(engine);
  let complete: ((error?: Error) => void) | undefined;
  try {
    engine.addPlayer('failed', 'Failed', socket, { x: 0, y: 0 });
    broadcaster.negotiateSnapshot(socket);
    const original = socket.send.bind(socket);
    vi.spyOn(socket, 'send').mockImplementation((data, options, callback) => {
      if (typeof options === 'object') {
        throw new Error('Unexpected send options');
      }
      original(data);
      complete = options ?? callback;
    });
    broadcaster.broadcastGameState();
    expect(socket.sent.at(-1)).toContain('"atlas":');
    assert(complete);
    complete(new Error('Controlled transport failure'));
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(broadcaster.acknowledgeSnapshot(socket, 1)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    engine.stopGameLoop();
  }
});
