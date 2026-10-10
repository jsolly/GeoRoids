import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import { WebSocketCore } from '../server/communication/WebSocketCore';
import { GameEngine } from '../server/core/GameEngine';
import { ServerClock } from '../server/core/ServerClock';
import { canCollectEquipment, isEquipmentId } from '../shared/equipment';
import { GAME_TICK_MS } from '../shared/gameClock';
import { validateSnapshotDto } from '../shared/snapshotDto';
import { quantizeSnapshotKinematics } from '../shared/snapshotPrecision';
import { SNAPSHOT_VERSION, SnapshotDecoder } from '../shared/snapshotProtocol';
import { nearbyAsteroidRows, nearbyWorldRows } from '../shared/world';
import type { ServerGameSnapshot } from '../shared-types';
import { GAME, LASER } from '../src/constants';
import { isActiveScanner } from '../src/entities/ship/surveyScan';
import { ownBenchmarkIdentity } from './benchmark-identity';
import { createOwnedLoopback, type OwnedLoopback } from './owned-loopback';
import { canonicalJson, type Measurement } from './results';

const CLOCK_START_MS = 1_700_000_000_000;
const DRAIN_TIMEOUT_MS = 5_000;
const CAPTURE_BYTES_LIMIT = 128 * 1024 * 1024;
const CAPTURE_MESSAGES_LIMIT = 20_000;
type SendCallback = (error?: Error) => void;
type SendOptions = {
  mask?: boolean | undefined;
  binary?: boolean | undefined;
  compress?: boolean | undefined;
  fin?: boolean | undefined;
};
type SendData = Parameters<WebSocket['send']>[0];

export interface WireLedgerOptions {
  readonly seed: number;
  readonly warmupTicks: number;
  readonly measuredTicks: number;
  readonly players: number;
}

export const DEFAULT_WIRE_LEDGER_OPTIONS: WireLedgerOptions = {
  seed: 42,
  warmupTicks: 60,
  measuredTicks: 240,
  players: 2,
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value);
  assert(text !== undefined, 'Wire ledger cannot count a non-JSON value');
  return Buffer.byteLength(text, 'utf8');
}

function propertyBytes(name: string, value: unknown): number {
  return jsonBytes(name) + 1 + jsonBytes(value);
}

/** Exact for a single unmasked, uncompressed, FIN text frame, checked against native TCP totals. */
export function websocketTextHeaderBytes(payloadBytes: number): 2 | 4 | 10 {
  assert(
    Number.isSafeInteger(payloadBytes) && payloadBytes >= 0,
    'Invalid WebSocket payload bytes'
  );
  return payloadBytes <= 125 ? 2 : payloadBytes <= 65_535 ? 4 : 10;
}

export interface SnapshotBytePartition {
  readonly kind: 'keyframe' | 'delta';
  readonly sequence: number;
  readonly baseline: number | null;
  readonly payloadBytes: number;
  readonly parts: Record<string, number>;
}

/** Each byte belongs to exactly one bucket. Container punctuation is explicit, never omitted. */
export function partitionSnapshotBytes(text: string): SnapshotBytePartition {
  const envelope: unknown = JSON.parse(text);
  assert(record(envelope) && envelope['type'] === 'snapshot' && record(envelope['data']));
  assert.equal(JSON.stringify(envelope), text, 'Ledger requires the exact canonical emitted JSON');
  const frame = envelope['data'];
  assert.equal(frame['version'], SNAPSHOT_VERSION, 'Ledger requires the current snapshot version');
  const kind = frame['kind'];
  assert(kind === 'keyframe' || kind === 'delta', 'Unknown snapshot kind');
  const sequence = frame['sequence'];
  assert(typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0);
  const parts: Record<string, number> = {};
  const add = (path: string, value: number) => {
    parts[path] = (parts[path] ?? 0) + value;
  };
  for (const [name, value] of Object.entries(envelope)) {
    if (name !== 'data') {
      add(`envelope.${name}`, propertyBytes(name, value));
    }
  }
  for (const [name, value] of Object.entries(frame)) {
    if (name !== 'state' && name !== 'patch') {
      add(`metadata.${name}`, propertyBytes(name, value));
    }
  }
  let baseline: number | null = null;
  if (kind === 'keyframe') {
    const state = frame['state'];
    assert(record(state), 'Keyframe has no state');
    for (const [name, value] of Object.entries(state)) {
      add(`state.${name}`, propertyBytes(name, value));
    }
  } else {
    const reference = frame['baseline'];
    assert(typeof reference === 'number' && Number.isSafeInteger(reference) && reference > 0);
    baseline = reference;
    const objectPatch = (patch: unknown, prefix: string, collectionPrefix: string): void => {
      assert(record(patch), 'Ledger requires an object patch');
      assert(
        Object.keys(patch).every((name) =>
          ['set', 'clear', 'collections', 'objects'].includes(name)
        ),
        'Ledger encountered an unknown patch member'
      );
      if (patch['set'] !== undefined) {
        assert(record(patch['set']));
        for (const [name, value] of Object.entries(patch['set'])) {
          add(`${prefix}.set.${name}`, propertyBytes(name, value));
        }
      }
      if (patch['clear'] !== undefined) {
        assert(Array.isArray(patch['clear']));
        add(`${prefix}.clear`, propertyBytes('clear', patch['clear']));
      }
      if (patch['collections'] !== undefined) {
        assert(record(patch['collections']));
        for (const [name, change] of Object.entries(patch['collections'])) {
          assert(record(change));
          assert(
            Object.keys(change).every((field) =>
              ['add', 'update', 'motion', 'remove', 'order'].includes(field)
            ),
            'Ledger encountered an unknown collection operation'
          );
          const rowPrefix = `${collectionPrefix}.${name}`;
          if (change['motion'] !== undefined) {
            assert(typeof change['motion'] === 'string');
            // Base64 quartets mix header/value bits. Attribute the actual complete
            // property once instead of inventing per-field text byte allocations.
            add(`${rowPrefix}.update.motion.packed`, propertyBytes('motion', change['motion']));
          }
          if (change['add'] !== undefined) {
            assert(Array.isArray(change['add']));
            for (const row of change['add']) {
              assert(record(row));
              for (const [field, value] of Object.entries(row)) {
                add(`${rowPrefix}.add.${field}`, propertyBytes(field, value));
              }
            }
          }
          if (change['update'] !== undefined) {
            assert(Array.isArray(change['update']));
            for (const update of change['update']) {
              assert(Array.isArray(update) && update.length >= 2);
              add(`${rowPrefix}.update.references`, jsonBytes(update[0]));
              if (typeof update[1] === 'number') {
                const mask = update[1];
                assert(
                  (name === 'asteroids' || name === 'spiders') &&
                    Number.isSafeInteger(mask) &&
                    mask > 0 &&
                    mask < 16 &&
                    (mask & 7) !== 0 &&
                    (name === 'asteroids' || (mask & 4) === 0),
                  'Ledger encountered an invalid motion mask'
                );
                add(`${rowPrefix}.update.motion.mask`, jsonBytes(mask));
                let index = 2;
                const motion = (field: string, size: number) => {
                  const values = update.slice(index, index + size);
                  assert(values.length === size && values.every(Number.isFinite));
                  if (mask & 8) {
                    assert(
                      values.every(Number.isSafeInteger),
                      'Relative motion has non-integer bytes'
                    );
                  }
                  add(
                    `${rowPrefix}.update.motion.${field}`,
                    values.reduce((sum, value) => sum + jsonBytes(value), 0)
                  );
                  index += size;
                };
                if (mask & 1) {
                  motion('position', 2);
                }
                if (mask & 2) {
                  motion(name === 'asteroids' ? 'rotation' : 'angle', 1);
                }
                if (mask & 4) {
                  motion('velocity', 2);
                }
                assert.equal(index, update.length, 'Ledger encountered an invalid motion tuple');
              } else {
                assert((update.length === 2 || update.length === 3) && record(update[1]));
                for (const [field, value] of Object.entries(update[1])) {
                  add(`${rowPrefix}.update.set.${field}`, propertyBytes(field, value));
                }
                if (update.length === 3) {
                  add(`${rowPrefix}.update.clear`, jsonBytes(update[2]));
                }
              }
            }
          }
          for (const field of ['remove', 'order']) {
            if (change[field] !== undefined) {
              assert(Array.isArray(change[field]));
              add(`${rowPrefix}.${field}`, propertyBytes(field, change[field]));
            }
          }
        }
      }
      if (patch['objects'] !== undefined) {
        assert(prefix === 'delta' && record(patch['objects']));
        for (const [name, child] of Object.entries(patch['objects'])) {
          assert.equal(name, 'spiderField', 'Ledger encountered an unknown nested object');
          objectPatch(child, `objects.${name}`, `objects.${name}.collections`);
        }
      }
    };
    objectPatch(frame['patch'], 'delta', 'collections');
  }
  const payloadBytes = Buffer.byteLength(text, 'utf8');
  const assigned = Object.values(parts).reduce((sum, count) => sum + count, 0);
  assert(assigned <= payloadBytes, 'Byte buckets overlap');
  parts['containers-and-punctuation'] = payloadBytes - assigned;
  assert.equal(
    Object.values(parts).reduce((sum, count) => sum + count, 0),
    payloadBytes
  );
  return { kind, sequence, baseline, payloadBytes, parts };
}

/** The oracle reads public engine state, never the broadcaster's prepared or retained baseline. */
function recipientSnapshotOracle(engine: GameEngine, id: string): ServerGameSnapshot {
  const player = engine.getPlayer(id);
  assert(player, 'Oracle pilot is missing');
  const common = engine.getSnapshotState();
  const asteroids = nearbyAsteroidRows(
    engine.getAllAsteroids(),
    player.position,
    isActiveScanner(player)
  );
  const source = {
    ...common,
    asteroids,
    loot: nearbyWorldRows(engine.getLoot(), player.position).filter(
      (drop) => !isEquipmentId(drop.kind) || canCollectEquipment(player, drop.kind)
    ),
    satellitePickups: [
      ...common.satellitePickups.filter((pickup) => pickup.ownerId === id),
      ...nearbyWorldRows(
        common.satellitePickups.filter(
          (pickup) => pickup.ownerId !== id && pickup.state !== 'stored'
        ),
        player.position
      ),
    ],
    playerProjectiles: nearbyWorldRows(engine.getPlayerProjectiles(), player.position),
  } satisfies ServerGameSnapshot;
  // Independent JSON ownership copy preserves undefined omission and negative-zero wire semantics.
  const owned: unknown = JSON.parse(JSON.stringify(source));
  validateSnapshotDto(owned);
  quantizeSnapshotKinematics(owned);
  return owned;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function runtimeStateHasher(): (state: ServerGameSnapshot) => string {
  const aliases = new Map<string, string>();
  return (state) =>
    sha256(
      canonicalJson(state).replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
        (uuid) => {
          const key = uuid.toLowerCase();
          const alias = aliases.get(key) ?? `runtime-id-${aliases.size + 1}`;
          aliases.set(key, alias);
          return alias;
        }
      )
    );
}

function seededRandom(seed: number): () => number {
  let state = (seed >>> 0) ^ 0x6d2b79f5;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface CapturedMessage {
  readonly pilot: string;
  readonly tick: number;
  readonly measured: boolean;
  readonly text: string;
  readonly payloadBytes: number;
  readonly websocketHeaderBytes: number;
  readonly rawSha256: string;
  readonly type: string;
  readonly snapshot?: SnapshotBytePartition & {
    decodedSha256: string;
    expectedSha256: string;
    normalizedStateSha256: string;
    rows: Record<string, number>;
    activeScan: boolean;
  };
}

/** Replay actual text, including events, rather than trusting a prepared encoder frame. */
export function replayWireLedger(messages: readonly CapturedMessage[]): number {
  const decoders = new Map<
    string,
    {
      decoder: SnapshotDecoder;
      sequence: number;
      normalizedHash: (state: ServerGameSnapshot) => string;
    }
  >();
  let snapshots = 0;
  for (const message of messages) {
    assert.equal(sha256(message.text), message.rawSha256, 'Captured raw frame changed');
    assert.equal(
      Buffer.byteLength(message.text, 'utf8'),
      message.payloadBytes,
      'Captured payload bytes changed'
    );
    assert.equal(websocketTextHeaderBytes(message.payloadBytes), message.websocketHeaderBytes);
    let stream = decoders.get(message.pilot);
    if (!stream) {
      stream = {
        decoder: new SnapshotDecoder(),
        sequence: 0,
        normalizedHash: runtimeStateHasher(),
      };
      decoders.set(message.pilot, stream);
    }
    const decoded = stream.decoder.readMessage(message.text, { acceptSnapshots: true });
    if (decoded.kind === 'snapshot-rejected') {
      throw decoded.error;
    }
    if (decoded.kind === 'snapshot') {
      const partition = partitionSnapshotBytes(message.text);
      assert(message.snapshot, 'Captured snapshot lost its outcome witness');
      assert.equal(partition.sequence, stream.sequence + 1, 'Replay skipped a snapshot sequence');
      if (stream.sequence === 0) {
        assert.equal(partition.kind, 'keyframe', 'Replay omitted a complete initial world');
      }
      if (partition.kind === 'delta') {
        assert.equal(partition.baseline, stream.sequence);
      }
      assert.equal(partition.kind, message.snapshot.kind);
      assert.equal(partition.sequence, message.snapshot.sequence);
      assert.equal(partition.payloadBytes, message.snapshot.payloadBytes);
      assert.equal(partition.baseline, message.snapshot.baseline);
      assert.deepEqual(
        partition.parts,
        message.snapshot.parts,
        'Captured field-byte partition changed'
      );
      assert.equal(
        sha256(canonicalJson(decoded.state)),
        message.snapshot.decodedSha256,
        'Replay decoded a changed state'
      );
      assert.equal(
        message.snapshot.decodedSha256,
        message.snapshot.expectedSha256,
        'Captured oracle disagreed'
      );
      assert.equal(
        stream.normalizedHash(decoded.state),
        message.snapshot.normalizedStateSha256,
        'Normalized outcome witness changed'
      );
      stream.sequence = partition.sequence;
      snapshots++;
    } else {
      assert(
        record(decoded.message) && decoded.message['type'] === message.type && !message.snapshot
      );
    }
  }
  return snapshots;
}

interface PilotStream {
  readonly id: string;
  readonly client: WebSocket;
  readonly peer: WebSocket;
  readonly decoder: SnapshotDecoder;
  readonly submitted: string[];
  readonly received: CapturedMessage[];
  readonly oracle: ServerGameSnapshot[];
  readonly initialTransportBytes: number;
  readonly readTransportBytes: () => number;
  readonly initialUplinkTransportBytes: number;
  readonly readUplinkTransportBytes: () => number;
  readonly acknowledgements: Array<{
    readonly sequence: number;
    readonly measured: boolean;
    readonly text: string;
    readonly payloadBytes: number;
    readonly websocketHeaderBytes: number;
  }>;
  readonly normalizedHash: (state: ServerGameSnapshot) => string;
  measuredTransportStart: number | undefined;
  measuredUplinkTransportStart: number | undefined;
  acknowledgementCallbacks: number;
  acknowledgementsHandled: number;
  sequence: number;
  sends: number;
  callbacks: number;
  snapshots: number;
}

/** Exact byte/state diagnostic. It intentionally drains between emits, so it cannot measure saturation. */
export async function runWireLedgerSample(
  options: WireLedgerOptions = DEFAULT_WIRE_LEDGER_OPTIONS
): Promise<Measurement> {
  assert(Number.isSafeInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffff_ffff);
  assert(Number.isSafeInteger(options.players) && options.players >= 2 && options.players <= 5);
  assert(
    Number.isSafeInteger(options.warmupTicks) &&
      options.warmupTicks >= 2 &&
      options.warmupTicks % 2 === 0
  );
  assert(
    Number.isSafeInteger(options.measuredTicks) &&
      options.measuredTicks >= 240 &&
      options.measuredTicks % 2 === 0
  );
  assert(
    options.warmupTicks + options.measuredTicks <= 3600,
    'Wire scene exceeds 3600 simulation ticks'
  );
  const savedDateNow = Date.now;
  const savedMathRandom = Math.random;
  const clock = { nowMs: CLOCK_START_MS };
  const failures: unknown[] = [];
  const streams: PilotStream[] = [];
  const messages: CapturedMessage[] = [];
  const broadcastMs: number[] = [];
  const decodeMs: number[] = [];
  let owner: OwnedLoopback | undefined;
  let engine: GameEngine | undefined;
  let core: WebSocketCore | undefined;
  let identity: ReturnType<typeof ownBenchmarkIdentity> | undefined;
  let tick = 0;
  let measuring = false;
  let capturedBytes = 0;
  const work = {
    motionOffered: 0,
    motionAccepted: 0,
    shotsOffered: 0,
    shotsAccepted: 0,
    measuredMotionAccepted: 0,
    measuredShotsAccepted: 0,
    measuredScanStates: 0,
    measuredNormalStates: 0,
    measuredSpiderFieldChanges: 0,
    abilityActivations: 0,
    resyncs: 0,
  };
  const observedShots = new Set<string>();
  const observedMeasuredShots = new Set<string>();
  const lastSpiderFields = new Map<string, string>();
  let result: Measurement | undefined;
  const observeStream = (stream: PilotStream) => (raw: WebSocket.RawData, binary: boolean) => {
    const id = stream.id;
    try {
      assert(!binary, 'Wire ledger received an unexpected binary message');
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(raw);
      const text = bytes.toString('utf8');
      const submitted = stream.submitted[stream.received.length];
      assert.equal(text, submitted, 'Actual outbound stream reordered or changed');
      const startedAt = performance.now();
      const decoded = stream.decoder.readMessage(text, { acceptSnapshots: true });
      const elapsed = performance.now() - startedAt;
      if (decoded.kind === 'snapshot-rejected') {
        throw decoded.error;
      }
      const payloadBytes = Buffer.byteLength(text, 'utf8');
      capturedBytes += payloadBytes;
      assert(
        capturedBytes <= CAPTURE_BYTES_LIMIT && messages.length < CAPTURE_MESSAGES_LIMIT,
        'Wire capture limit exceeded'
      );
      let snapshot: CapturedMessage['snapshot'];
      let type: string;
      if (decoded.kind === 'snapshot') {
        const expected = stream.oracle.shift();
        assert(expected, 'Snapshot has no independent emission oracle');
        assert.deepEqual(
          decoded.state,
          expected,
          'Recipient decoded a changed authoritative state'
        );
        assert.equal(decoded.metadata.sequence, stream.sequence + 1, 'Recipient sequence skipped');
        const partition = partitionSnapshotBytes(text);
        if (partition.kind === 'delta') {
          assert.equal(partition.baseline, stream.sequence);
        }
        stream.sequence = partition.sequence;
        stream.snapshots++;
        const decodedSha256 = sha256(canonicalJson(decoded.state));
        const expectedSha256 = sha256(canonicalJson(expected));
        assert.equal(decodedSha256, expectedSha256);
        const local = expected.entities.find((candidate) => candidate.id === id);
        assert(local, 'Recipient state lost its own pilot');
        assert(
          local.kitId !== undefined && local.abilityActiveFrames !== undefined,
          'Own pilot lost its ability state'
        );
        const activeScan = isActiveScanner({
          ...local,
          kitId: local.kitId,
          abilityActiveFrames: local.abilityActiveFrames,
        });
        snapshot = {
          ...partition,
          decodedSha256,
          expectedSha256,
          normalizedStateSha256: stream.normalizedHash(expected),
          activeScan,
          rows: {
            entities: expected.entities.length,
            asteroids: expected.asteroids.length,
            loot: expected.loot.length,
            mapAssets: expected.mapAssets.length,
            exploration: expected.exploration.length,
            satellites: expected.satellitePickups.length,
            projectiles: expected.playerProjectiles.length,
            spiders: expected.spiderField?.spiders.length ?? 0,
            nests: expected.spiderField?.nests.length ?? 0,
          },
        };
        for (const shot of decoded.state.playerProjectiles) {
          observedShots.add(shot.id);
          if (measuring && expected.gameTime - shot.age > options.warmupTicks) {
            observedMeasuredShots.add(shot.id);
          }
        }
        const spiderField = JSON.stringify(expected.spiderField);
        if (measuring) {
          if (activeScan) {
            work.measuredScanStates++;
          } else {
            work.measuredNormalStates++;
          }
          if (lastSpiderFields.has(id) && lastSpiderFields.get(id) !== spiderField) {
            work.measuredSpiderFieldChanges++;
          }
        }
        if (spiderField !== undefined) {
          lastSpiderFields.set(id, spiderField);
        }
        if (measuring) {
          decodeMs.push(elapsed);
        }
        type = 'snapshot';
      } else {
        assert(record(decoded.message) && typeof decoded.message['type'] === 'string');
        type = decoded.message['type'];
        assert(
          type !== 'error' && type !== 'sessionExpired',
          'Broadcaster reported failed gameplay'
        );
      }
      const captured: CapturedMessage = {
        pilot: id,
        tick,
        measured: measuring,
        text,
        payloadBytes,
        websocketHeaderBytes: websocketTextHeaderBytes(payloadBytes),
        rawSha256: sha256(text),
        type,
        ...(snapshot ? { snapshot } : {}),
      };
      stream.received.push(captured);
      messages.push(captured);
      if (snapshot) {
        // Credit follows every independent state/hash/application check, on the
        // actual owned client socket. Client uploads are separate from downlink.
        const acknowledgement = JSON.stringify({
          type: 'snapshotAck',
          data: { sequence: snapshot.sequence },
        });
        const acknowledgementBytes = Buffer.byteLength(acknowledgement, 'utf8');
        stream.acknowledgements.push({
          sequence: snapshot.sequence,
          measured: measuring,
          text: acknowledgement,
          payloadBytes: acknowledgementBytes,
          websocketHeaderBytes: websocketTextHeaderBytes(acknowledgementBytes) + 4,
        });
        stream.client.send(acknowledgement, (error) => {
          stream.acknowledgementCallbacks++;
          if (error) {
            failures.push(error);
          }
        });
      }
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    identity = ownBenchmarkIdentity(options.seed);
    Date.now = () => clock.nowMs;
    Math.random = seededRandom(options.seed);
    owner = await createOwnedLoopback();
    engine = new GameEngine(
      options.seed,
      new ServerClock({
        wallNow: () => clock.nowMs,
        monotonicNow: () => clock.nowMs - CLOCK_START_MS,
      })
    );
    engine.updatePauseState();
    core = new WebSocketCore(engine);
    const activeCore = core;
    const broadcaster = core.getBroadcaster();
    engine.setOnAsteroidHits((hits) =>
      core?.getMessageHandler().broadcastAppliedAsteroidHits(hits)
    );
    for (let index = 0; index < options.players; index++) {
      const connection: Awaited<ReturnType<OwnedLoopback['connect']>> = await owner.connect();
      const { client, peer, transport } = connection;
      assert.equal(
        client.extensions,
        '',
        'Wire ledger requires the current uncompressed transport'
      );
      assert.equal(peer.extensions, '', 'Server unexpectedly negotiated compression');
      const id = `wire-pilot-${index}`;
      const stream: PilotStream = {
        id,
        client,
        peer,
        decoder: new SnapshotDecoder(),
        submitted: [],
        received: [],
        oracle: [],
        initialTransportBytes: transport.bytesWritten,
        readTransportBytes: () => transport.bytesWritten,
        initialUplinkTransportBytes: transport.bytesRead,
        readUplinkTransportBytes: () => transport.bytesRead,
        acknowledgements: [],
        normalizedHash: runtimeStateHasher(),
        measuredTransportStart: undefined,
        measuredUplinkTransportStart: undefined,
        acknowledgementCallbacks: 0,
        acknowledgementsHandled: 0,
        sequence: 0,
        sends: 0,
        callbacks: 0,
        snapshots: 0,
      };
      streams.push(stream);
      const send = peer.send.bind(peer);
      peer.send = (
        data: SendData,
        optionsOrCallback?: SendOptions | SendCallback,
        callback?: SendCallback
      ) => {
        assert(typeof data === 'string', 'Production broadcaster emitted a non-text frame');
        stream.submitted.push(data);
        stream.sends++;
        const originalCallback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        const completed = (error?: Error) => {
          try {
            originalCallback?.(error);
          } finally {
            stream.callbacks++;
            if (error) {
              failures.push(error);
            }
          }
        };
        if (typeof optionsOrCallback === 'object') {
          send(data, optionsOrCallback, completed);
        } else {
          send(data, completed);
        }
      };
      client.on('message', observeStream(stream));
      peer.on('message', (raw, binary) => {
        try {
          assert(!binary, 'Wire pilot sent an unexpected binary acknowledgement');
          const text = raw.toString();
          const acknowledgement = stream.acknowledgements[stream.acknowledgementsHandled];
          assert(acknowledgement, 'Server received unoffered client work');
          assert.equal(text, acknowledgement.text, 'Snapshot credit upload changed or reordered');
          const message: unknown = JSON.parse(text);
          activeCore.handleClientMessage(message, peer);
          stream.acknowledgementsHandled++;
        } catch (error) {
          failures.push(error);
        }
      });
      const angle = (index / options.players) * Math.PI * 2;
      const actor = engine.addPlayer(
        id,
        `Wire Pilot ${index}`,
        peer,
        {
          x: Math.cos(angle) * 600,
          y: Math.sin(angle) * 600,
        },
        'scout'
      );
      engine.enableAsteroidInteractions(actor);
      const registered: ReturnType<GameEngine['registerPilot']> = engine.registerPilot(actor, peer);
      assert(registered.ok, 'Motion fixture registration failed');
      assert.equal(broadcaster.negotiateSnapshot(peer), SNAPSHOT_VERSION);
    }
    const activeEngine = engine;
    const activeOwner = owner;
    const drain = async () => {
      const deadline = performance.now() + DRAIN_TIMEOUT_MS;
      while (
        streams.some(
          (stream) =>
            stream.received.length !== stream.sends ||
            stream.callbacks !== stream.sends ||
            stream.oracle.length !== 0 ||
            stream.acknowledgementCallbacks !== stream.acknowledgements.length ||
            stream.acknowledgementsHandled !== stream.acknowledgements.length
        )
      ) {
        activeOwner.assertHealthy();
        if (failures.length) {
          throw new AggregateError(failures, 'Wire receive or callback failed');
        }
        assert(performance.now() < deadline, 'Wire receive/callback drain timed out');
        await nextTurn();
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Wire receive failed');
      }
      activeOwner.assertHealthy();
    };
    const emit = async () => {
      for (const stream of streams) {
        stream.oracle.push(recipientSnapshotOracle(activeEngine, stream.id));
      }
      const startedAt = performance.now();
      broadcaster.broadcastGameState();
      const elapsed = performance.now() - startedAt;
      if (measuring) {
        broadcastMs.push(elapsed);
      }
      await drain();
    };
    // Deliberately exercise moving global spider rows outside both pilots' radar circles.
    for (let index = 0; index < 8; index++) {
      assert(
        engine.spawnTerrainSpider({ x: 3200 + index * 70, y: 1000 }, index / 8),
        'Spider fixture could not spawn'
      );
    }
    await emit();
    const initial = recipientSnapshotOracle(engine, streams[0]?.id ?? '');
    let forcedSequence: number | undefined;
    for (tick = 1; tick <= options.warmupTicks + options.measuredTicks; tick++) {
      measuring = tick > options.warmupTicks;
      if (tick === options.warmupTicks + 1) {
        for (const stream of streams) {
          stream.measuredTransportStart = stream.readTransportBytes();
          stream.measuredUplinkTransportStart = stream.readUplinkTransportBytes();
        }
      }
      clock.nowMs += GAME_TICK_MS;
      if (tick % 2 === 0) {
        for (const stream of streams) {
          const actor = engine.getPlayer(stream.id);
          assert(actor, 'Wire fixture lost a participant');
          const motion = engine.playerMotion.getState(actor.id);
          if (
            actor.health > 0 &&
            !actor.exploding &&
            motion &&
            ['free', 'handoff'].includes(motion.mode)
          ) {
            work.motionOffered++;
            const outcome = engine.playerMotion.acceptFreePose(
              stream.peer,
              {
                epoch: motion.epoch,
                sequence: work.motionOffered,
                position: { x: actor.position.x + 0.1, y: actor.position.y },
                velocity: { x: 0.05, y: 0 },
                angle: 0,
                thrusting: true,
                contourLock: null,
              },
              engine.getServerTime()
            );
            assert(outcome.ok, 'Controlled public motion was rejected');
            work.motionAccepted++;
            if (measuring) {
              work.measuredMotionAccepted++;
            }
            if (tick % 20 === 0) {
              work.shotsOffered++;
              const shot = engine.spawnPlayerLaser(
                actor.id,
                { ...actor.position },
                {
                  x: LASER.SPEED / GAME.FPS + actor.velocity.x,
                  y: actor.velocity.y,
                }
              );
              assert(shot, 'Controlled public shot was rejected');
              work.shotsAccepted++;
              if (measuring) {
                work.measuredShotsAccepted++;
              }
              core
                .getMessageHandler()
                .broadcastAppliedAsteroidHits(engine.resolveSpawnedLaserHits(shot.id));
            }
          }
        }
      }
      if (tick === options.warmupTicks + 1) {
        const first = streams[0];
        assert(
          first && engine.useAbility(first.id, 'scout'),
          'Real Mineral Scan activation failed'
        );
        work.abilityActivations++;
      }
      engine.advanceOneFrame();
      if (tick === options.warmupTicks + 160) {
        const first = streams[0];
        assert(first);
        forcedSequence = first.sequence + 1;
        broadcaster.requestSnapshotKeyframe(first.peer);
        work.resyncs++;
      }
      if (tick % 2 === 0) {
        await emit();
      } else {
        await drain();
      }
    }
    await drain();
    assert.equal(owner.clients.length, options.players, 'Owned client count changed');
    assert.equal(owner.peers.length, options.players, 'An unexpected loopback peer connected');
    assert.deepEqual(
      engine
        .getAllPlayers()
        .map((actor) => actor.id)
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      streams.map((stream) => stream.id).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      'Authoritative participants changed'
    );
    assert(
      work.motionAccepted > 0 && work.shotsAccepted > 0 && observedShots.size > 0,
      'Wire fixture omitted admitted movement or observed shots'
    );
    assert(
      work.measuredMotionAccepted > 0 &&
        work.measuredShotsAccepted > 0 &&
        observedMeasuredShots.size > 0,
      'Measured wire window omitted admitted movement or observed shots'
    );
    assert(
      work.measuredScanStates > 0 &&
        work.measuredNormalStates > 0 &&
        work.measuredSpiderFieldChanges > 0,
      'Wire window omitted scan lifecycle or moving spider work'
    );
    assert.equal(work.abilityActivations, 1);
    assert.equal(work.resyncs, 1);
    const first = streams[0];
    assert(first && forcedSequence !== undefined);
    const forced = first.received.find((message) => message.snapshot?.sequence === forcedSequence);
    const following = first.received.find(
      (message) => message.snapshot?.sequence === forcedSequence + 1
    );
    assert.equal(forced?.snapshot?.kind, 'keyframe', 'Resync did not produce a keyframe');
    assert.equal(
      following?.snapshot?.kind,
      'delta',
      'Resync did not return to incremental snapshots'
    );
    const ledger = streams.map((stream) => {
      const actualWebsocketBytes = stream.readTransportBytes() - stream.initialTransportBytes;
      const applicationBytes = stream.received.reduce(
        (sum, message) => sum + message.payloadBytes,
        0
      );
      const websocketHeaderBytes = stream.received.reduce(
        (sum, message) => sum + message.websocketHeaderBytes,
        0
      );
      assert.equal(
        actualWebsocketBytes,
        applicationBytes + websocketHeaderBytes,
        'Actual TCP bytes disagree with the text-frame ledger'
      );
      const measured = stream.received.filter((message) => message.measured);
      assert.equal(
        stream.acknowledgements.length,
        stream.snapshots,
        'A snapshot lost its applied credit'
      );
      const acknowledgementApplicationBytes = stream.acknowledgements.reduce(
        (sum, acknowledgement) => sum + acknowledgement.payloadBytes,
        0
      );
      const acknowledgementHeaderBytes = stream.acknowledgements.reduce(
        (sum, acknowledgement) => sum + acknowledgement.websocketHeaderBytes,
        0
      );
      const actualAcknowledgementWebsocketBytes =
        stream.readUplinkTransportBytes() - stream.initialUplinkTransportBytes;
      assert.equal(
        actualAcknowledgementWebsocketBytes,
        acknowledgementApplicationBytes + acknowledgementHeaderBytes,
        'Actual ACK upload TCP bytes disagree with the masked frame ledger'
      );
      const measuredAcknowledgements = stream.acknowledgements.filter(
        (acknowledgement) => acknowledgement.measured
      );
      const measuredAcknowledgementApplicationBytes = measuredAcknowledgements.reduce(
        (sum, acknowledgement) => sum + acknowledgement.payloadBytes,
        0
      );
      const measuredAcknowledgementHeaderBytes = measuredAcknowledgements.reduce(
        (sum, acknowledgement) => sum + acknowledgement.websocketHeaderBytes,
        0
      );
      assert(stream.measuredUplinkTransportStart !== undefined);
      const actualMeasuredAcknowledgementWebsocketBytes =
        stream.readUplinkTransportBytes() - stream.measuredUplinkTransportStart;
      assert.equal(
        actualMeasuredAcknowledgementWebsocketBytes,
        measuredAcknowledgementApplicationBytes + measuredAcknowledgementHeaderBytes,
        'Measured ACK upload TCP window disagrees with the masked frame ledger'
      );
      assert(stream.measuredTransportStart !== undefined);
      const actualMeasuredWebsocketBytes =
        stream.readTransportBytes() - stream.measuredTransportStart;
      const measuredApplicationBytes = measured.reduce(
        (sum, message) => sum + message.payloadBytes,
        0
      );
      const measuredHeaderBytes = measured.reduce(
        (sum, message) => sum + message.websocketHeaderBytes,
        0
      );
      assert.equal(
        actualMeasuredWebsocketBytes,
        measuredApplicationBytes + measuredHeaderBytes,
        'Measured TCP window disagreed with the frame ledger'
      );
      const fieldBytes: Record<string, number> = {};
      const applicationBytesByType: Record<string, number> = {};
      for (const message of measured) {
        applicationBytesByType[message.type] =
          (applicationBytesByType[message.type] ?? 0) + message.payloadBytes;
      }
      for (const message of measured) {
        for (const [name, count] of Object.entries(message.snapshot?.parts ?? {})) {
          fieldBytes[name] = (fieldBytes[name] ?? 0) + count;
        }
      }
      const measuredSnapshotBytes = measured.reduce(
        (sum, message) => sum + (message.snapshot?.payloadBytes ?? 0),
        0
      );
      assert.equal(
        Object.values(fieldBytes).reduce((sum, count) => sum + count, 0),
        measuredSnapshotBytes
      );
      return {
        pilot: stream.id,
        actualWebsocketBytes,
        snapshotAcknowledgements: stream.acknowledgements.length,
        measuredSnapshotAcknowledgements: measuredAcknowledgements.length,
        acknowledgementApplicationBytes,
        acknowledgementHeaderBytes,
        actualAcknowledgementWebsocketBytes,
        measuredAcknowledgementApplicationBytes,
        measuredAcknowledgementHeaderBytes,
        actualMeasuredAcknowledgementWebsocketBytes,
        applicationBytes,
        websocketHeaderBytes,
        actualMeasuredWebsocketBytes,
        measuredApplicationBytes,
        measuredHeaderBytes,
        measuredSnapshotBytes,
        measuredKeyframeBytes: measured.reduce(
          (sum, message) =>
            sum + (message.snapshot?.kind === 'keyframe' ? message.payloadBytes : 0),
          0
        ),
        measuredDeltaBytes: measured.reduce(
          (sum, message) => sum + (message.snapshot?.kind === 'delta' ? message.payloadBytes : 0),
          0
        ),
        offeredWebsocketBytesPerSimulatedSecond:
          actualMeasuredWebsocketBytes / (options.measuredTicks / GAME.FPS),
        measuredSnapshots: measured.filter((message) => message.snapshot).length,
        measuredKeyframes: measured.filter((message) => message.snapshot?.kind === 'keyframe')
          .length,
        measuredDeltas: measured.filter((message) => message.snapshot?.kind === 'delta').length,
        fieldBytes,
        applicationBytesByType,
        sends: stream.sends,
        callbacks: stream.callbacks,
      };
    });
    assert(
      ledger.every((row) => row.measuredDeltas > 0),
      'Measured streams omitted delta work'
    );
    const replayedSnapshots = replayWireLedger(messages);
    assert.equal(
      replayedSnapshots,
      streams.reduce((sum, stream) => sum + stream.snapshots, 0)
    );
    assert(
      streams.every((stream) => {
        const initialFrame = stream.received.find((message) => message.snapshot)?.snapshot;
        return initialFrame?.kind === 'keyframe' && initialFrame.sequence === 1;
      }),
      'A recipient stream omitted its complete initial world'
    );
    const final = recipientSnapshotOracle(engine, first.id);
    const rawStreamSha256 = sha256(
      messages
        .map((message) => JSON.stringify({ pilot: message.pilot, text: message.text }))
        .join('\n')
    );
    result = {
      primaryMetric: 'broadcastSubmissionMs',
      samples: { broadcastSubmissionMs: broadcastMs, decoderMs: decodeMs },
      counts: {
        ...work,
        observedProjectiles: observedShots.size,
        observedMeasuredProjectiles: observedMeasuredShots.size,
        replayedSnapshots,
        players: streams.length,
        simulationTicks: options.warmupTicks + options.measuredTicks,
        measuredBroadcasts: broadcastMs.length,
        measuredSnapshots: ledger.reduce((sum, row) => sum + row.measuredSnapshots, 0),
        capturedMessages: messages.length,
        capturedApplicationBytes: capturedBytes,
        actualWebsocketBytes: ledger.reduce((sum, row) => sum + row.actualWebsocketBytes, 0),
        snapshotAcknowledgements: ledger.reduce(
          (sum, row) => sum + row.snapshotAcknowledgements,
          0
        ),
        measuredSnapshotAcknowledgements: ledger.reduce(
          (sum, row) => sum + row.measuredSnapshotAcknowledgements,
          0
        ),
        acknowledgementApplicationBytes: ledger.reduce(
          (sum, row) => sum + row.acknowledgementApplicationBytes,
          0
        ),
        actualAcknowledgementWebsocketBytes: ledger.reduce(
          (sum, row) => sum + row.actualAcknowledgementWebsocketBytes,
          0
        ),
      },
      parameters: {
        ...options,
        identitySource: identity.source,
        fixture: 'seeded-real-broadcaster-wire-v2',
        simulationHz: 60,
        offeredSnapshotHz: 30,
        snapshotVersion: SNAPSHOT_VERSION,
        keyframePolicy: 'initial/recovery/strictlysmaller',
        initialDateNow: CLOCK_START_MS,
        clocks:
          'Controlled epoch/simulation clock; native CPU timers; serialized socket/callback draining',
        scope:
          'Public engine APIs and real broadcaster/loopback sockets; no full production input validation or persistence',
        transport:
          'Current uncompressed text frames; TCP byte totals exclude upgrade and cleanup, not TCP/IP/TLS headers',
        acknowledgement:
          'Every independently verified applied snapshot sends a real masked client ACK through production command handling; ACK uploads have separate exact TCP byte proofs and drain before the next offer',
        timing:
          'Diagnostic synchronous CPU submission including send interception; hashes/partitions/equality outside timestamps',
        bandwidth:
          'Offered bytes per simulated second only; not wall-clock throughput, constrained-network latency, or recipient freshness',
        captureLimits: { bytes: CAPTURE_BYTES_LIMIT, messages: CAPTURE_MESSAGES_LIMIT },
      },
      witness: {
        initial,
        final,
        ledger,
        rawStreamSha256,
        messages,
        resync: {
          pilot: first.id,
          keyframeSequence: forcedSequence,
          followingDeltaSequence: forcedSequence + 1,
        },
        decodedSnapshots:
          'Every actual received snapshot matched its independently filtered selected-precision engine state',
      },
      cleanup: 'complete',
    };
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      core?.stopPeriodicGameStateBroadcast();
      engine?.stopGameLoop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owner?.close();
    } catch (error) {
      failures.push(error);
    }
    Date.now = savedDateNow;
    Math.random = savedMathRandom;
    try {
      identity?.release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const error = new AggregateError([...new Set(failures)], 'Wire ledger or owned cleanup failed');
    // sample.ts retains this bounded evidence on failure, including partial receipts.
    throw Object.assign(error, { wireEvidence: { tick, work, capturedBytes, messages } });
  }
  assert(result, 'Wire ledger produced no result');
  return result;
}
