import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { parse } from 'yaml';
import { MessageHandler } from '../server/communication/MessageHandler';
import { GameEngine } from '../server/core/GameEngine';
import { GameStateBroadcaster } from '../server/services/GameStateBroadcaster';
import { SnapshotDecoder as ProductionDecoder } from '../shared/snapshotProtocol';
import { RecordingSocket } from '../tests/support/recordingSocket';
import {
  CandidatePoseObserver,
  candidateDecoderFactory,
  loadCandidateProtocol,
} from './ci-browser-smoke-protocol';
import { SnapshotDecoder as LiveDecoder } from './fixtures/browser-smoke-decoder';
import { SnapshotDecoder as InvalidDecoder } from './fixtures/browser-smoke-invalid-decoder';

const fixturePath = fileURLToPath(new URL('./fixtures/browser-smoke-decoder.ts', import.meta.url));
const invalidFixturePath = fileURLToPath(
  new URL('./fixtures/browser-smoke-invalid-decoder.ts', import.meta.url)
);
const privateMarker = 'PRIVATE-CONTROL-MUST-NOT-REACH-ARTIFACTS';
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function joined(id = 'self'): string {
  return JSON.stringify({
    kind: 'message',
    message: {
      type: 'joined',
      data: { id, snapshotVersion: 3, asteroidInteractions: 1, resumeToken: privateMarker },
    },
  });
}
function snapshot(
  sequence = 1,
  rows: readonly unknown[] = [
    { id: 'self', position: { x: 1, y: 2 }, angle: 3 },
    { id: 'peer', position: { x: 4, y: 5 }, angle: 6 },
  ]
): string {
  return JSON.stringify({ kind: 'snapshot', metadata: { sequence }, state: { entities: rows } });
}
function observer() {
  return new CandidatePoseObserver({
    createDecoder: candidateDecoderFactory({ SnapshotDecoder: LiveDecoder }),
    target: () => 'peer',
  });
}
function stateOf(wire: CandidatePoseObserver) {
  return wire.state;
}

async function candidateFixture(
  run: (fixture: {
    workspace: string;
    root: string;
    sha: string;
    path: string;
    commit: () => string;
  }) => Promise<void>,
  source = fixturePath
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'browser-candidate-codec-'));
  const root = join(workspace, 'candidate');
  const path = join(root, 'shared/snapshotProtocol.ts');
  const gitEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Codec fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Codec fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  try {
    mkdirSync(join(root, 'shared'), { recursive: true });
    mkdirSync(join(workspace, 'verification/shared'), { recursive: true });
    copyFileSync(source, path);
    copyFileSync(invalidFixturePath, join(workspace, 'verification/shared/snapshotProtocol.ts'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: root,
        env: gitEnvironment,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init', '--template=']);
    const commit = (): string => {
      git(['add', 'shared/snapshotProtocol.ts', 'package.json']);
      const tree = git(['write-tree']);
      const sha = execFileSync('git', ['commit-tree', tree, '-m', 'Owned decoder fixture'], {
        cwd: root,
        encoding: 'utf8',
        env: gitEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      git(['update-ref', 'HEAD', sha]);
      return sha;
    };
    const sha = commit();
    await run({ workspace, root, sha, path, commit });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('the fixed candidate checkout supplies the live decoder while trusted verification supplies assertions', async () => {
  await candidateFixture(async ({ workspace, root, sha, path }) => {
    const protocol = await loadCandidateProtocol({
      workspaceRoot: workspace,
      candidateRoot: root,
      requestedSha: sha,
    });
    assert.deepEqual(protocol.identity, {
      source: 'candidate',
      requestedSha: sha,
      observedSha: sha,
      modulePath: 'shared/snapshotProtocol.ts',
      moduleSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      constructionMode: 'live',
    });
    const wire = new CandidatePoseObserver({
      createDecoder: protocol.createDecoder,
      target: () => 'peer',
    });
    const socket = wire.openSocket();
    socket.receive(joined());
    socket.receive(snapshot());
    assert.deepEqual(wire.state.pose, { id: 'peer', sequence: 1, x: 4, y: 5, angle: 6 });
    assert.deepEqual(wire.failures, []);
    assert(
      !JSON.stringify({
        identity: protocol.identity,
        state: wire.state,
        failures: wire.failures,
      }).includes(privateMarker)
    );
  });
});

test('a later checked commit at the same path cannot reuse the previous module from cache', async () => {
  await candidateFixture(async ({ workspace, root, sha, path, commit }) => {
    await loadCandidateProtocol({
      workspaceRoot: workspace,
      candidateRoot: root,
      requestedSha: sha,
    });
    copyFileSync(invalidFixturePath, path);
    const nextSha = commit();
    assert.notEqual(nextSha, sha);
    await assert.rejects(
      loadCandidateProtocol({
        workspaceRoot: workspace,
        candidateRoot: root,
        requestedSha: nextSha,
      })
    );
  });
});

test('a decoder fixture leaves the calling gate index untouched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-caller-index-'));
  const index = join(directory, 'index');
  const original = Buffer.from('Owned caller index must remain byte-identical');
  const inherited = process.env['GIT_INDEX_FILE'];
  writeFileSync(index, original);
  process.env['GIT_INDEX_FILE'] = index;
  try {
    await candidateFixture(async ({ workspace, root, sha }) => {
      await loadCandidateProtocol({
        workspaceRoot: workspace,
        candidateRoot: root,
        requestedSha: sha,
      });
    });
    assert.deepEqual(readFileSync(index), original);
  } finally {
    if (inherited === undefined) {
      delete process.env['GIT_INDEX_FILE'];
    } else {
      process.env['GIT_INDEX_FILE'] = inherited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrong roots, changed source, escaped modules and mismatched commits cannot select another decoder', async () => {
  await candidateFixture(async ({ workspace, root, sha, path }) => {
    const settings = { workspaceRoot: workspace, candidateRoot: root, requestedSha: sha };
    for (const candidateRoot of [
      undefined,
      'candidate',
      join(workspace, 'verification'),
      join(workspace, 'missing'),
    ]) {
      await assert.rejects(
        loadCandidateProtocol({ ...settings, candidateRoot }),
        /^Error: Candidate protocol identity or module validation failed$/u
      );
    }
    await assert.rejects(loadCandidateProtocol({ ...settings, requestedSha: '0'.repeat(40) }));
    appendFileSync(path, '\n// Modified after checkout\n');
    await assert.rejects(loadCandidateProtocol(settings));
    unlinkSync(path);
    symlinkSync(fixturePath, path);
    await assert.rejects(loadCandidateProtocol(settings));
  });
  await candidateFixture(async ({ workspace, root, sha }) => {
    await assert.rejects(
      loadCandidateProtocol({ workspaceRoot: workspace, candidateRoot: root, requestedSha: sha })
    );
  }, invalidFixturePath);
});

test('construction checks the live argument and required methods without a fallback or leaked exception', () => {
  const live = candidateDecoderFactory({ SnapshotDecoder: LiveDecoder })();
  live.reset();
  assert.deepEqual(
    live.readMessage('{"kind":"message","message":{"type":"other"}}', { acceptSnapshots: false }),
    { kind: 'message', message: { type: 'other' } }
  );
  for (const namespace of [null, {}, { SnapshotDecoder: InvalidDecoder }]) {
    assert.throws(() => candidateDecoderFactory(namespace));
  }
  for (const Constructor of [
    () => ({}),
    function rejectedConstructor(): Promise<never> {
      return Promise.reject(new Error(privateMarker));
    },
    class {},
    class {
      constructor() {
        throw new Error(privateMarker);
      }
    },
  ]) {
    assert.throws(
      () => candidateDecoderFactory({ SnapshotDecoder: Constructor })(),
      /^Error: Candidate decoder construction failed$/u
    );
  }
  const throwing = candidateDecoderFactory({
    SnapshotDecoder: class {
      reset(): void {
        throw new Error(privateMarker);
      }
      readMessage(): never {
        throw new Error(privateMarker);
      }
    },
  })();
  assert.throws(() => throwing.reset(), /^Error: Candidate decoder reset failed$/u);
  assert.throws(
    () => throwing.readMessage('ignored', { acceptSnapshots: false }),
    /^Error: Candidate decoder read failed$/u
  );
  const asynchronous = candidateDecoderFactory({
    SnapshotDecoder: class {
      reset(): Promise<void> {
        return Promise.reject(new Error(privateMarker));
      }
      readMessage(): Promise<never> {
        return Promise.reject(new Error(privateMarker));
      }
    },
  })();
  assert.throws(() => asynchronous.reset(), /^Error: Candidate decoder reset failed$/u);
  assert.throws(
    () => asynchronous.readMessage('ignored', { acceptSnapshots: false }),
    /^Error: Candidate decoder read failed$/u
  );
});

test('new joined sessions and physical sockets clear poses and fence retired messages and closes', () => {
  const wire = observer();
  const retired = wire.openSocket();
  retired.receive(joined());
  retired.receive(snapshot());
  assert(stateOf(wire).pose);
  retired.receive(
    JSON.stringify({
      kind: 'message',
      message: { type: 'notice', data: { resumeToken: privateMarker } },
    })
  );
  retired.receive(
    snapshot(2, [
      null,
      { id: 'unrelated', position: privateMarker },
      { id: 'peer', position: { x: 4, y: 5 }, angle: 6 },
    ])
  );
  assert.equal(stateOf(wire).pose?.id, 'peer');
  assert(!JSON.stringify(stateOf(wire)).includes(privateMarker));
  retired.receive(joined('replacement'));
  assert.equal(stateOf(wire).id, 'replacement');
  assert.equal(stateOf(wire).pose, null);
  assert.equal(stateOf(wire).ownPose, null);
  const current = wire.openSocket();
  assert.equal(stateOf(wire).kind, 'waiting');
  retired.receive(joined('retired'));
  current.receive(joined());
  current.receive(snapshot(2));
  retired.close();
  retired.receive(snapshot(99));
  assert.equal(stateOf(wire).pose?.sequence, 2);
  current.receive(snapshot(3, [{ id: 'self', position: { x: 1, y: 2 }, angle: 3 }]));
  assert.equal(stateOf(wire).pose, null);
  current.close();
  current.receive(joined('closed'));
  assert.equal(stateOf(wire).kind, 'waiting');
  assert.deepEqual(wire.failures, []);
});

test('only finite identified poses after common protocol admission can become evidence', () => {
  const bad: unknown[] = [
    { kind: 'unknown', private: privateMarker },
    { kind: 'snapshot-rejected', error: privateMarker },
    { kind: 'snapshot', metadata: { sequence: 0 }, state: { entities: [] } },
    { kind: 'snapshot', metadata: { sequence: 1.5 }, state: { entities: [] } },
    {
      kind: 'snapshot',
      metadata: { sequence: 1 },
      state: { entities: [{ id: 'peer', position: { x: '4', y: 5 }, angle: 6 }] },
    },
    {
      kind: 'snapshot',
      metadata: { sequence: 1 },
      state: { entities: [{ id: 'peer', position: { x: 4, y: 5 }, angle: null }] },
    },
    {
      kind: 'snapshot',
      metadata: { sequence: 1 },
      state: {
        entities: [
          { id: 'peer', position: { x: 4, y: 5 }, angle: 6 },
          { id: 'peer', position: { x: 4, y: 5 }, angle: 6 },
        ],
      },
    },
    {
      kind: 'message',
      message: {
        type: 'joined',
        data: { id: 'self', snapshotVersion: 3, asteroidInteractions: 0 },
      },
    },
  ];
  for (const result of bad) {
    const wire = observer();
    const channel = wire.openSocket();
    channel.receive(joined());
    channel.receive(JSON.stringify(result));
    assert.equal(wire.state.pose, null);
    assert.deepEqual(wire.failures, ['Candidate protocol observation failed']);
    assert(!JSON.stringify(wire.failures).includes(privateMarker));
  }
  for (const angle of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const wire = new CandidatePoseObserver({
      target: () => 'peer',
      createDecoder: () => ({
        reset() {},
        readMessage(_text, admission) {
          if (admission.acceptSnapshots) {
            return {
              kind: 'snapshot',
              metadata: { sequence: 1 },
              state: { entities: [{ id: 'peer', position: { x: 4, y: 5 }, angle }] },
            };
          }
          const ack: unknown = JSON.parse(joined());
          return ack;
        },
      }),
    });
    const channel = wire.openSocket();
    channel.receive('join');
    channel.receive('snapshot');
    assert.equal(wire.state.pose, null);
    assert.equal(wire.failures.length, 1);
  }
  const wire = observer();
  const channel = wire.openSocket();
  channel.receive(snapshot());
  assert.equal(wire.state.kind, 'waiting');
  assert.equal(wire.failures.length, 1);
  for (let i = 0; i < 100; i++) {
    channel.receive(Buffer.from('not text'));
  }
  assert.equal(wire.failures.length, 50);
});

test('the actual production codec supplies independent keyframe, delta, rejection and reset behavior', () => {
  const engine = new GameEngine(82);
  try {
    const broadcaster = new GameStateBroadcaster(engine);
    const handler = new MessageHandler(engine, broadcaster);
    const socket = new RecordingSocket();
    handler.handleMessage(
      {
        type: 'join',
        id: 'owned',
        data: {
          name: 'Codec observer',
          position: { x: 0, y: 0 },
          kitId: 'scout',
          snapshotVersion: 3,
          asteroidInteractions: 1,
          explorationVersion: 1,
          cooperativeVersion: 1,
        },
      },
      socket
    );
    const createDecoder = candidateDecoderFactory({ SnapshotDecoder: ProductionDecoder });
    const wires = [0, 1].map(
      () => new CandidatePoseObserver({ createDecoder, target: () => 'owned' })
    );
    const channels = wires.map((wire) => wire.openSocket());
    for (const text of socket.sent) {
      for (const channel of channels) {
        channel.receive(text);
      }
    }
    assert(wires.every((wire) => wire.state.ownPose?.sequence === 1 && wire.failures.length === 0));
    const first = socket.sent.find((text) => record(JSON.parse(text))['type'] === 'snapshot');
    const ack = socket.sent.find((text) => record(JSON.parse(text))['type'] === 'joined');
    assert(first && ack);
    handler.handleMessage({ type: 'snapshotAck', data: { sequence: 1 } }, socket);
    const cursor = socket.sent.length;
    broadcaster.broadcastGameState();
    const delta = socket.sent
      .slice(cursor)
      .find((text) => record(JSON.parse(text))['type'] === 'snapshot');
    assert(delta && record(record(JSON.parse(delta))['data'])['kind'] === 'delta');
    for (const channel of channels) {
      channel.receive(delta);
    }
    assert(wires.every((wire) => wire.state.ownPose?.sequence === 2 && wire.failures.length === 0));
    const primaryChannel = channels[0];
    const primaryWire = wires[0];
    assert(primaryChannel && primaryWire);
    primaryChannel.receive(ack);
    assert.equal(stateOf(primaryWire).ownPose, null);
    primaryChannel.receive(delta);
    assert.equal(primaryWire.failures.length, 1);
    primaryChannel.receive(first);
    assert.equal(stateOf(primaryWire).ownPose?.sequence, 1);
    primaryChannel.receive('{"type":"snapshot","data":{}}');
    assert.equal(primaryWire.failures.length, 2);
    assert(!JSON.stringify(primaryWire.state).includes('resumeToken'));
  } finally {
    engine.stopGameLoop();
  }
});

test('the workflow passes its fixed candidate root while keeping the verification entry trusted', () => {
  const workflow = record(
    parse(readFileSync(new URL('../.github/workflows/browser-smoke.yml', import.meta.url), 'utf8'))
  );
  const browser = record(record(workflow['jobs'])['browser']);
  assert(Array.isArray(browser['steps']));
  const steps = browser['steps'].map(record);
  const checkout = steps.find(
    (step) => step['name'] === "Check out the workflow's verification code"
  );
  assert(checkout);
  const ref = record(checkout['with'])['ref'];
  assert(typeof ref === 'string');
  assert.match(ref, /^\$\{\{ github\.workflow_sha \}\}$/u);
  const run = steps.find((step) => step['name'] === 'Run the local browser smoke');
  assert(run && typeof run['run'] === 'string');
  assert.match(
    run['run'],
    /candidate_root="\$GITHUB_WORKSPACE\/candidate"\s+export BROWSER_SMOKE_CANDIDATE_ROOT="\$candidate_root"/u
  );
  assert.match(
    run['run'],
    /cd "\$GITHUB_WORKSPACE\/verification"\s+node --import tsx scripts\/ci-browser-smoke\.ts/u
  );
});
