import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MessageHandler } from '../server/communication/MessageHandler';
import { GameEngine } from '../server/core/GameEngine';
import { ServerClock } from '../server/core/ServerClock';
import { GameStateBroadcaster } from '../server/services/GameStateBroadcaster';
import { InlineWorldPersistence } from '../server/world/InlineWorldPersistence';
import { WorldStore } from '../server/world/WorldStore';
import { SnapshotDecoder } from '../shared/snapshotProtocol';
import { WORLD } from '../shared/world';
import type { ServerGameSnapshot } from '../shared-types';
import { RecordingSocket } from '../tests/support/recordingSocket';
import { ownBenchmarkIdentity } from './benchmark-identity';
import { canonicalJson } from './results';
import { recipientSnapshotOracle } from './snapshot-oracle';
import { websocketTextHeaderBytes } from './websocket-frame-bytes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const PRIVATE_CREDENTIAL = /"resumeToken"\s*:/u;
const EVIDENCE_PAYLOAD_BYTES = 8 * 1024 * 1024;
const HARNESS_SOURCES = [
  'benchmarks/atlas-resync.ts',
  'benchmarks/benchmark-identity.ts',
  'benchmarks/snapshot-oracle.ts',
  'benchmarks/websocket-frame-bytes.ts',
  'benchmarks/results.ts',
  'tests/support/recordingSocket.ts',
];
const REQUIRED_SOURCES = [
  ...HARNESS_SOURCES,
  'shared/exploration.ts',
  'shared/snapshotProtocol.ts',
  'server/core/GameEngine.ts',
  'server/services/GameStateBroadcaster.ts',
  'server/world/MapAssets.ts',
  'server/world/WorldStore.ts',
  'server/world/worldPersistence.ts',
];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceInventory(): string[] {
  const files = ['shared-types.ts', 'package.json', 'package-lock.json'];
  const extensions = new Set(['.ts', '.mts', '.mjs', '.svelte', '.astro', '.json', '.jsonc']);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(resolve(ROOT, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      assert(!entry.isSymbolicLink(), 'Pinned source inventory contains a symlink');
      if (entry.isDirectory()) {
        visit(name);
      } else if (entry.isFile() && extensions.has(extname(name))) {
        files.push(name);
      }
      assert(files.length <= 4096, 'Source inventory exceeds inspection budget');
    }
  };
  for (const directory of ['shared', 'server', 'src', 'setup', 'benchmarks', 'tests/support']) {
    visit(directory);
  }
  return files;
}

/** No Git/network discovery. Root prepares retained source artifacts and their
 * complete authored-source file manifest before reserving the measurement slot. */
function verifySource(manifestPath: string, artifactPath: string) {
  const text = readFileSync(manifestPath, 'utf8');
  const manifest: unknown = JSON.parse(text);
  assert(
    object(manifest) &&
      typeof manifest['baseRevision'] === 'string' &&
      REVISION.test(manifest['baseRevision'])
  );
  assert(
    manifest['patchSha256'] === null ||
      (typeof manifest['patchSha256'] === 'string' && HASH.test(manifest['patchSha256']))
  );
  assert(typeof manifest['artifactSha256'] === 'string' && HASH.test(manifest['artifactSha256']));
  assert.equal(
    sha256(readFileSync(artifactPath)),
    manifest['artifactSha256'],
    'Source artifact changed'
  );
  const files = manifest['files'];
  assert(object(files) && Object.keys(files).length > 0 && Object.keys(files).length <= 4096);
  for (const name of REQUIRED_SOURCES) {
    assert(Object.hasOwn(files, name), `Unpinned harness/product owner: ${name}`);
  }
  for (const name of sourceInventory()) {
    assert(Object.hasOwn(files, name), `Unpinned authored source: ${name}`);
  }
  if (existsSync(resolve(ROOT, 'shared/atlasTransport.ts'))) {
    assert(Object.hasOwn(files, 'shared/atlasTransport.ts'));
  }
  let bytes = 0;
  for (const [name, expected] of Object.entries(files)) {
    const path = resolve(ROOT, name);
    assert(
      !isAbsolute(name) &&
        path.startsWith(`${ROOT}${sep}`) &&
        typeof expected === 'string' &&
        HASH.test(expected)
    );
    const contents = readFileSync(path);
    bytes += contents.length;
    assert(bytes <= 128 * 1024 * 1024, 'Source manifest exceeds inspection budget');
    assert.equal(sha256(contents), expected, `Pinned source changed: ${name}`);
  }
  return {
    baseRevision: manifest['baseRevision'],
    patchSha256: manifest['patchSha256'],
    artifactSha256: manifest['artifactSha256'],
    manifestSha256: sha256(text),
    files: Object.keys(files).length,
  };
}

export function readAtlasFixture(path: string) {
  const text = readFileSync(path, 'utf8');
  const value: unknown = JSON.parse(text);
  assert(
    object(value) &&
      value['version'] === 1 &&
      value['seed'] === 82 &&
      value['columns'] === 60 &&
      value['rows'] === 20
  );
  assert(value['startedAt'] === 1_700_000_000_000 && value['bits'] === `01${'00'.repeat(31)}`);
  const pilot = value['pilot'];
  const reveal = value['reveal'];
  assert(object(pilot) && pilot['x'] === 0 && pilot['y'] === 0);
  assert(object(reveal) && reveal['x'] === -59_812.5 && reveal['y'] === -59_937.5);
  return {
    sha256: sha256(text),
    seed: value['seed'],
    startedAt: value['startedAt'],
    pilot: { x: pilot['x'], y: pilot['y'] },
    reveal: { x: reveal['x'], y: reveal['y'] },
    tiles: Array.from({ length: 1200 }, (_, slot) => ({
      id: `${slot % 60},${Math.floor(slot / 60)}`,
      bits: `01${'00'.repeat(31)}`,
    })),
  };
}

interface WindowEvidence {
  readonly name: string;
  readonly firstKeyframeBytes: number;
  readonly snapshotPayloadBytes: number;
  readonly atlasFieldBytes: number;
  readonly snapshotFrames: number;
  readonly acknowledgementPayloadBytes: number;
  readonly framedDownstreamBytes: number;
  readonly framedAcknowledgementBytes: number;
  readonly completeWorldSha256: string;
  readonly frames: readonly { payloadBytes: number; sha256: string; text: string }[];
}

function measureAtlasResync(fixturePath: string): WindowEvidence[] {
  const fixture = readAtlasFixture(fixturePath);
  const store = new WorldStore(':memory:');
  const priorDateNow = Date.now;
  let identity: ReturnType<typeof ownBenchmarkIdentity> | undefined;
  let engine: GameEngine | undefined;
  let evidenceBytes = 0;
  try {
    identity = ownBenchmarkIdentity(fixture.seed);
    Date.now = () => fixture.startedAt;
    store.checkpoint(
      {
        seed: fixture.seed,
        startedAt: fixture.startedAt,
        generation: WORLD.generation,
        exploration: fixture.tiles,
      },
      new Map(),
      []
    );
    engine = new GameEngine(
      fixture.seed,
      new ServerClock({ wallNow: () => fixture.startedAt, monotonicNow: () => 0 }),
      new InlineWorldPersistence(store)
    );
    const broadcaster = new GameStateBroadcaster(engine);
    const handler = new MessageHandler(engine, broadcaster);
    const socket = new RecordingSocket();
    // Extra constructor arguments are intentionally ignored by the old product.
    // The same pinned harness exercises old complete worlds and new live worlds.
    const candidate: unknown = Reflect.construct(SnapshotDecoder, ['live']);
    assert(candidate instanceof SnapshotDecoder);
    const decoder = candidate;
    const owner = 'atlas-measurement';
    let cursor = 0;
    const runWindow = (name: string, action: () => void): WindowEvidence => {
      let payload = 0,
        atlasBytes = 0,
        frames = 0,
        ackBytes = 0,
        framed = 0,
        framedAcks = 0,
        keyframe = 0;
      let state: ServerGameSnapshot | undefined;
      let complete = false;
      const recorded: Array<{ payloadBytes: number; sha256: string; text: string }> = [];
      action();
      for (let offer = 0; offer < 256; offer++) {
        while (cursor < socket.sent.length) {
          const text = socket.sent[cursor++];
          assert(text);
          const result = decoder.readMessage(text, { acceptSnapshots: true });
          if (result.kind === 'message') {
            if (object(result.message) && result.message['type'] === 'joined') {
              decoder.reset();
            }
            continue;
          }
          if (result.kind === 'snapshot-rejected') {
            throw result.error;
          }
          const envelope: unknown = JSON.parse(text);
          assert(object(envelope) && object(envelope['data']));
          const atlas = envelope['data']['atlas'];
          if (atlas !== undefined) {
            atlasBytes += Buffer.byteLength(JSON.stringify({ atlas })) - 2;
          } else {
            const wireState = envelope['data']['state'];
            if (object(wireState) && wireState['exploration'] !== undefined) {
              atlasBytes +=
                Buffer.byteLength(JSON.stringify({ exploration: wireState['exploration'] })) - 2;
            }
          }
          const bytes = Buffer.byteLength(text);
          assert(
            text.startsWith('{"type":"snapshot",') && !PRIVATE_CREDENTIAL.test(text),
            'Evidence accepts credential-free snapshots only'
          );
          evidenceBytes += bytes;
          assert(evidenceBytes <= EVIDENCE_PAYLOAD_BYTES, 'Atlas evidence exceeds payload budget');
          recorded.push({ payloadBytes: bytes, sha256: sha256(text), text });
          payload += bytes;
          framed += bytes + websocketTextHeaderBytes(bytes);
          frames++;
          if (!keyframe && result.metadata.kind === 'keyframe') {
            keyframe = bytes;
          }
          const ack = { type: 'snapshotAck', data: { sequence: result.metadata.sequence } };
          const acknowledgementBytes = Buffer.byteLength(JSON.stringify(ack));
          ackBytes += acknowledgementBytes;
          framedAcks += acknowledgementBytes + websocketTextHeaderBytes(acknowledgementBytes) + 4;
          handler.handleMessage(ack, socket);
          state = result.state;
          complete = !('atlasSyncing' in result) || result.atlasSyncing === false;
          // Moving-world correctness holds throughout a partial atlas baseline.
          const expected = recipientSnapshotOracle(engineOwner(), owner);
          const { exploration: _actualAtlas, ...actualWorld } = state;
          const { exploration: _expectedAtlas, ...expectedWorld } = expected;
          assert.deepEqual(actualWorld, expectedWorld);
        }
        if (complete && state) {
          assert.deepEqual(state, recipientSnapshotOracle(engineOwner(), owner));
          return {
            name,
            firstKeyframeBytes: keyframe,
            snapshotPayloadBytes: payload,
            atlasFieldBytes: atlasBytes,
            snapshotFrames: frames,
            acknowledgementPayloadBytes: ackBytes,
            framedDownstreamBytes: framed,
            framedAcknowledgementBytes: framedAcks,
            completeWorldSha256: sha256(canonicalJson(state)),
            frames: recorded,
          };
        }
        broadcaster.broadcastGameState();
      }
      throw new Error('Atlas recovery exceeded fixed offer inventory');
    };
    const engineOwner = (): GameEngine => {
      assert(engine);
      return engine;
    };
    const joined = runWindow('initial-baseline', () =>
      handler.handleMessage(
        {
          type: 'join',
          id: owner,
          data: {
            name: 'Atlas measurement',
            position: fixture.pilot,
            kitId: 'scout',
            snapshotVersion: 3,
            asteroidInteractions: 1,
            explorationVersion: 1,
            cooperativeVersion: 1,
          },
        },
        socket
      )
    );
    const unchanged = runWindow('same-socket-unchanged-resync', () => {
      handler.handleMessage({ type: 'snapshotResync', data: {} }, socket);
      broadcaster.broadcastGameState();
    });
    engine.revealArea(fixture.reveal, 1);
    engine.checkpointWorld();
    const changed = runWindow('same-socket-one-tile-resync', () => {
      handler.handleMessage({ type: 'snapshotResync', data: {} }, socket);
      broadcaster.broadcastGameState();
    });
    return [joined, unchanged, changed];
  } finally {
    try {
      engine?.stopGameLoop();
    } finally {
      Date.now = priorDateNow;
      try {
        store.close();
      } finally {
        identity?.release();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      'source-manifest': { type: 'string' },
      artifact: { type: 'string' },
      output: { type: 'string' },
    },
  });
  assert(values.fixture && values['source-manifest'] && values.artifact && values.output);
  const source = verifySource(values['source-manifest'], values.artifact);
  const fixture = readAtlasFixture(values.fixture);
  const windows = measureAtlasResync(values.fixture);
  const receipt = {
    version: 1,
    source,
    harnessSha256: sha256(
      canonicalJson(
        Object.fromEntries(
          HARNESS_SOURCES.map((name) => [name, sha256(readFileSync(resolve(ROOT, name)))])
        )
      )
    ),
    fixtureSha256: fixture.sha256,
    node: process.version,
    boundary:
      'RecordingSocket application payloads and exact RFC6455 uncompressed framing; no TCP/TLS, timing, rendering or fleet-capacity claim',
    windows,
  };
  const artifact = `${JSON.stringify(receipt, null, 2)}\n`;
  assert(Buffer.byteLength(artifact) <= 20 * 1024 * 1024, 'Atlas evidence exceeds artifact budget');
  writeFileSync(values.output, artifact, {
    flag: 'wx',
    mode: 0o600,
  });
}
