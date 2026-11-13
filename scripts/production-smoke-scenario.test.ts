import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'vitest';
import WebSocket from 'ws';
import { decodeClientCommand } from '../server/communication/clientCommandDecoder.ts';
import { frontierSite } from '../shared/frontier.ts';
import { type SnapshotBaseline, SnapshotEncoder } from '../shared/snapshotProtocol.ts';
import type { Position, ServerEntityData } from '../shared-types.ts';
import { snapshotFixture } from '../tests/unit/network/snapshotFixture.ts';
import { runNetworkSmoke, SmokeFailure } from './production-smoke-network.mjs';
import type { SmokeSocket, SmokeSocketEvents } from './production-smoke-network.mts';
import { productionUrl, smoke, waitForClientAssets } from './production-smoke-scenario.mjs';

type NetworkOptions = Parameters<typeof runNetworkSmoke>[0];
type ScenarioContext = Parameters<NetworkOptions['scenario']['smoke']>[0];
type Timer = ReturnType<NonNullable<NetworkOptions['clock']>['setTimeout']>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert(typeof value === 'string');
  return value;
}
function number(value: unknown): number {
  assert(typeof value === 'number');
  return value;
}
function isPosition(value: unknown): value is Position {
  return isRecord(value) && typeof value['x'] === 'number' && typeof value['y'] === 'number';
}
function vector(value: unknown): Position {
  assert(isPosition(value));
  return value;
}
function errorAt(errors: Error[], index: number): Error {
  const error = errors[index];
  assert(error);
  return error;
}
function cause(error: Error): Error {
  assert(error.cause instanceof Error);
  return error.cause;
}
function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}
function parseRecord(raw: string): Record<string, unknown> {
  const value = parseJson(raw);
  return record(value);
}
class ControlledSocket
  extends EventEmitter<SmokeSocketEvents & { 'close-requested': [] }>
  implements SmokeSocket
{
  readyState: number = WebSocket.CONNECTING;
  send: (text: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  constructor(send: (text: string) => void, close: (code?: number) => void, terminate: () => void) {
    super();
    this.send = send;
    this.close = close;
    this.terminate = terminate;
  }
}
const release = 'a'.repeat(40),
  oldRelease = 'b'.repeat(40);
const healthy = {
  releaseId: release,
  world: { persistence: { mode: 'worker', failed: false }, loop: { stalls: 0 } },
};
const env = {
  PRODUCTION_SMOKE_REQUEST_ID: 'coded-smoke',
  PRODUCTION_SMOKE_RELEASE_SHA: release,
};

function controlledClock() {
  let now = 0,
    next = 0;
  const timers = new Map<Timer | undefined, { at: number; callback: () => void }>();
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return {
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal | undefined) => {
      signal?.throwIfAborted();
      advance(ms);
      await Promise.resolve();
      signal?.throwIfAborted();
    },
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++next;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id: Timer | undefined) => timers.delete(id),
    advance,
    pending: () => timers.size,
  };
}
function response(url: string, body: unknown, type = 'application/json', status = 200): Response {
  const result = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
interface HttpFixtureOptions {
  manifest?: string;
  bundle?: string;
  bundleSource?: string;
  world?: unknown;
  status?: number;
  assetType?: string;
  html?: string;
  redirect?: string;
  assetsManifest?: unknown;
}
function clientHttp({
  manifest = release,
  bundle = release,
  bundleSource,
  world = healthy,
  status = 200,
  assetType = 'application/javascript',
  html,
  redirect,
  assetsManifest,
}: HttpFixtureOptions = {}) {
  return (url: string): Promise<Response> => {
    let result: Response;
    if (url.endsWith('/release.json')) {
      result = response(url, { releaseSha: manifest });
    } else if (url.endsWith('/client-assets.json')) {
      result = response(
        url,
        assetsManifest ?? {
          releaseSha: manifest,
          gameplay: ['assets/game-coded.js'],
          modules: { 'assets/game-coded.js': [] },
        }
      );
    } else if (url.endsWith('/health')) {
      result = response(url, world);
    } else if (url.endsWith('.js')) {
      result = response(url, bundleSource ?? `const release = "${bundle}";`, assetType, status);
    } else if (url.endsWith('.css')) {
      result = response(url, 'canvas { display: block; }', 'text/css');
    } else {
      result = response(
        url,
        html ??
          '<html><canvas id="gameCanvas"></canvas><script type="module" src="/assets/game-coded.js"></script><link rel="stylesheet" href="/assets/game-coded.css"></html>',
        'text/html'
      );
    }
    const redirected = Boolean(redirect);
    if (redirected) {
      Object.defineProperty(result, 'url', { value: redirect });
    }
    return Promise.resolve(result);
  };
}
function codedSocket(outcome = 'accepted', initialState: Record<string, unknown> = {}) {
  let socket: ControlledSocket | undefined;
  const sent: Record<string, unknown>[] = [];
  const transportFailure = new Error('Controlled socket transport failure');
  const createSocket = (url: string, options: WebSocket.ClientOptions) => {
    assert.equal(
      url,
      'wss://georoids-production-2403.up.railway.app/ws?snapshotVersion=3&asteroidInteractions=1'
    );
    assert.equal(options.origin, new URL(productionUrl).origin);
    assert.equal(options.handshakeTimeout, 15000);
    let owned: ControlledSocket;
    let id: string | undefined;
    let sequence = 0;
    let baseline: SnapshotBaseline | undefined;
    let player: ServerEntityData | undefined;
    const receive = (type: string, data: unknown) =>
      owned.emit('message', Buffer.from(JSON.stringify({ type, data })));
    const snapshot = () => {
      const state = snapshotFixture();
      assert(player);
      state.entities = [player];
      const encoder = new SnapshotEncoder(state),
        frame = encoder.encode(++sequence, baseline);
      baseline = { sequence, state: encoder.state };
      receive(
        'snapshot',
        frame.kind === 'keyframe' ? { ...frame, state: { ...frame.state, ...initialState } } : frame
      );
    };
    const send = (body: string): void => {
      const message = parseRecord(body);
      assert.equal(
        decodeClientCommand(message).ok,
        true,
        'Smoke requests must satisfy the current server command decoder'
      );
      sent.push(message);
      if (message['type'] === 'join') {
        const data = record(message['data']);
        id = text(message['id']);
        assert.equal(data['snapshotVersion'], 3);
        assert.equal(data['asteroidInteractions'], 1);
        assert.equal(data['cooperativeVersion'], 1);
        assert.equal(data['clientReleaseId'], release);
        assert.equal(data['resumeToken'], undefined);
        const base = snapshotFixture().entities[0];
        assert(base);
        player = {
          ...base,
          id,
          position: { x: 0, y: 0 },
          velocity: { x: 0, y: 0 },
          angle: 0,
          playerMotion: { epoch: 1, ack: 0, mode: 'free' },
        };
        if (outcome === 'snapshot-before-join') {
          snapshot();
          return;
        }
        receive('joined', {
          id: outcome === 'wrong-player' ? 'other' : id,
          snapshotVersion: outcome === 'old-protocol' ? 2 : 3,
          asteroidInteractions: 1,
          resumeToken: 'private-resume-token',
          serverReleaseId: outcome === 'stale-server' ? oldRelease : release,
        });
        if (outcome === 'malformed-json') {
          owned.emit('message', Buffer.from('socketSecret'));
          return;
        }
        if (outcome === 'malformed-snapshot') {
          receive('snapshot', { version: 999 });
          return;
        }
        snapshot();
        if (outcome !== 'missing-second-snapshot') {
          snapshot();
        }
      } else if (message['type'] === 'update') {
        const data = record(message['data']);
        assert(player);
        assert.equal(data['motionEpoch'], 1);
        assert.equal(data['motionSequence'], 1);
        player = {
          ...player,
          position: vector(data['position']),
          velocity: vector(data['velocity']),
          angle: number(data['angle']),
          playerMotion: {
            epoch: outcome === 'wrong-motion-epoch' ? 2 : 1,
            ack: outcome === 'missing-motion-ack' ? 0 : number(data['motionSequence']),
            mode: 'free',
          },
        };
        if (outcome === 'no-movement') {
          player.position = { x: 0, y: 0 };
        }
        snapshot();
      } else if (message['type'] === 'shoot') {
        const data = record(message['data']);
        assert.equal(message['id'], id);
        assert.equal(typeof data['requestId'], 'string');
        assert.ok(number(record(data['laserDirection'])['x']) > 0);
        if (outcome === 'missing-shot-ack') {
          return;
        }
        receive('shotAcknowledged', {
          requestId: outcome === 'wrong-shot-request' ? 'other-request' : data['requestId'],
          projectileId:
            outcome === 'rejected-shot'
              ? null
              : outcome === 'malformed-shot-ack'
                ? 42
                : 'accepted-bolt',
        });
      }
    };
    const close = (code?: number): void => {
      assert.equal(code, 1000);
      if (outcome === 'close-timeout') {
        owned.emit('close-requested');
        return;
      }
      if (outcome === 'error-on-close') {
        owned.emit('error', transportFailure);
      }
      owned.readyState = WebSocket.CLOSED;
      owned.emit(
        'close',
        outcome === 'close-only-1006' ? 1006 : outcome === 'close-only-1011' ? 1011 : 1000,
        Buffer.from('private-resume-token')
      );
    };
    const terminate = (): void => {
      owned.readyState = WebSocket.CLOSED;
      owned.emit('close', 1006);
    };
    owned = new ControlledSocket(send, close, terminate);
    socket = owned;
    queueMicrotask(() => {
      owned.readyState = WebSocket.OPEN;
      owned.emit('open');
      if (outcome === 'transport-failure') {
        owned.emit('error', transportFailure);
      }
    });
    return owned;
  };
  return {
    createSocket,
    socket: () => {
      assert(socket);
      return socket;
    },
    sent: () => sent,
    failure: transportFailure,
  };
}
async function fixture(run: (artifacts: string, reports: Error[]) => Promise<void>): Promise<void> {
  const artifacts = await mkdtemp(join(tmpdir(), 'georoids-coded-smoke-'));
  try {
    await run(artifacts, []);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
}

function campaignFixture(): Record<string, unknown> {
  const site = frontierSite('frontier:3,0');
  assert(site);
  return {
    projectValue: 123,
    supplies: [{ id: 'town-square', value: 500 }],
    hives: [
      {
        kind: 'hive',
        id: site.id,
        position: site.position,
        frontier: site.frontier,
        queenHealth: 500,
        birthFramesLeft: 480,
        clearedAt: null,
        sacs: [50, 50],
        sacDeadline: null,
        sacsCompletedAt: null,
        restoredValue: 0,
        contributors: ['private-campaign-contributor'],
        commissionedAt: null,
        shieldOpen: false,
      },
    ],
    commissioned: ['frontier:2,0'],
    cleared: ['frontier:2,0', 'frontier:0,2'],
    hazard: {
      phase: 'warning',
      kind: 'swarm',
      startsAt: 1800000,
      endsAt: 1980000,
      privateDetail: 'private-campaign-detail',
    },
    meteors: [{ id: 'private-campaign-meteor', position: { x: 50, y: 50 } }],
    privateDetail: 'private-campaign-detail',
  };
}

test('the deployed HTTP assets and genuine current-protocol gameplay produce a canonical receipt without private credentials', async () => {
  await fixture(async (artifacts, reports) => {
    const transport = codedSocket('accepted', {
        cooperativeActive: true,
        campaign: campaignFixture(),
      }),
      clock = controlledClock();
    const volume = {
      status: 'ok',
      sampledAt: 10000,
      freeBytes: 800000000,
      databaseBytes: 12000000,
      walBytes: 4096,
      warningBytes: 384 * 1024 * 1024,
    };
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp({
        world: {
          ...healthy,
          world: {
            ...healthy.world,
            persistence: {
              ...healthy.world.persistence,
              volume: { ...volume, privateHealthField: 'private-volume-detail' },
            },
          },
        },
      }),
      clock,
      createSocket: transport.createSocket,
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, true);
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.requestId, env.PRODUCTION_SMOKE_REQUEST_ID);
    assert.equal(receipt.releaseSha, release);
    const health = receipt.observations.filter(
      (observation) => record(observation)['source'] === 'server-health'
    );
    assert.equal(health.length, 2);
    for (const observation of health) {
      assert.deepEqual(record(observation)['volume'], volume);
    }
    const campaign = receipt.observations
      .map(record)
      .filter((observation) => observation['source'] === 'initial-campaign-state');
    assert.deepEqual(campaign, [
      {
        source: 'initial-campaign-state',
        activation: 'active',
        summary: {
          status: 'available',
          nearbyHiveCount: 1,
          clearedCount: 2,
          commissionedCount: 1,
          hazard: { phase: 'warning', kind: 'swarm', startsAt: 1800000, endsAt: 1980000 },
        },
      },
    ]);
    assert.equal(clock.pending(), 0);
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    assert.ok(transport.sent().filter((message) => message['type'] === 'snapshotAck').length >= 3);
    assert.equal(record(transport.sent().at(-1))['type'], 'leave');
    const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence['acceptedSnapshots'], 3);
    assert.equal(record(evidence['admission'])['snapshotVersion'], 3);
    assert.match(text(record(evidence['admission'])['playerId']), /^smoke-/u);
    assert.equal(record(evidence['movement'])['acknowledged'], 1);
    assert.equal(record(evidence['movement'])['displacement'], 6);
    assert.equal(record(evidence['shot'])['projectileId'], 'accepted-bolt');
    assert.equal(evidence['socketClosed'], true);
    assert.equal(evidence['closeCode'], 1000);
    const retained = JSON.stringify(receipt) + JSON.stringify(evidence);
    assert.doesNotMatch(
      retained,
      /private-resume-token|private-github-token|resumeToken|authorization|privateHealthField|private-volume-detail|private-campaign|frontier:2,0|frontier:0,2|frontier:3,0|projectValue|supplies|contributors/u
    );
    assert.deepEqual(parseJson(await readFile(join(artifacts, 'receipt.json'), 'utf8')), receipt);
  });
});

for (const [activation, initialState] of [
  ['missing', {}],
  ['disabled', { cooperativeActive: false }],
  ['active', { cooperativeActive: true }],
] satisfies Array<[string, Record<string, unknown>]>) {
  test(`initial campaign evidence reports ${activation} activation without inventing progress`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket('accepted', initialState);
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        createSocket: transport.createSocket,
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, true);
      assert.deepEqual(
        receipt.observations
          .map(record)
          .filter((observation) => observation['source'] === 'initial-campaign-state'),
        [{ source: 'initial-campaign-state', activation, summary: { status: 'missing' } }]
      );
      assert.equal(reports.length, 0);
    });
  });
}

for (const [label, initialState] of [
  ['non-boolean activation', { cooperativeActive: 'private-campaign-detail' }],
  ['null summary', { cooperativeActive: true, campaign: null }],
  [
    'non-array hive records',
    { cooperativeActive: true, campaign: { ...campaignFixture(), hives: {} } },
  ],
  [
    'unknown hazard phase',
    {
      cooperativeActive: true,
      campaign: {
        ...campaignFixture(),
        hazard: { phase: 'private-campaign-detail', kind: 'swarm', startsAt: 0, endsAt: 1 },
      },
    },
  ],
  [
    'negative hazard start',
    {
      cooperativeActive: true,
      campaign: {
        ...campaignFixture(),
        hazard: { phase: 'active', kind: 'meteors', startsAt: -1, endsAt: 1 },
      },
    },
  ],
] satisfies Array<[string, Record<string, unknown>]>) {
  test(`invalid public campaign ${label} is rejected before movement or shooting`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket('accepted', initialState);
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        createSocket: transport.createSocket,
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, false);
      assert.deepEqual(receipt.errors, ['Gameplay snapshot failed current protocol validation']);
      assert.equal(
        transport
          .sent()
          .some((command) => command['type'] === 'update' || command['type'] === 'shoot'),
        false
      );
      assert.equal(transport.socket().readyState, WebSocket.CLOSED);
      assert.doesNotMatch(
        inspect(reports, { depth: 10 }) +
          (await readFile(join(artifacts, 'receipt.json'), 'utf8')) +
          (await readFile(join(artifacts, 'gameplay-server.json'), 'utf8')),
        /private-campaign/u
      );
    });
  });
}

for (const outcome of [
  'wrong-player',
  'old-protocol',
  'snapshot-before-join',
  'malformed-snapshot',
  'malformed-json',
  'missing-second-snapshot',
  'wrong-motion-epoch',
  'missing-motion-ack',
  'no-movement',
  'missing-shot-ack',
  'wrong-shot-request',
  'rejected-shot',
  'malformed-shot-ack',
  'transport-failure',
]) {
  test(`code verification rejects ${outcome} and closes only its owned socket`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket(outcome),
        clock = controlledClock();
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        clock,
        createSocket: transport.createSocket,
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, false);
      assert.ok(receipt.errors.length > 0);
      assert.equal(transport.socket().readyState, WebSocket.CLOSED);
      assert.equal(clock.pending(), 0);
      assert.doesNotMatch(JSON.stringify(receipt), /private-resume-token|private-github-token/u);
      const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence['socketClosed'], true);
      assert.ok(evidence['error']);
      if (outcome === 'transport-failure') {
        assert.equal(reports.length, 1);
        assert.equal(errorAt(reports, 0).cause, transport.failure);
      }
      if (outcome === 'malformed-json') {
        assert.deepEqual(receipt.errors, ['Malformed gameplay protocol message']);
        assert.equal(reports.length, 1);
        assert.equal(cause(errorAt(reports, 0)).message, 'Gameplay JSON parsing failed');
        assert.doesNotMatch(
          inspect(reports, { depth: 10 }) +
            JSON.stringify(receipt) +
            (await readFile(join(artifacts, 'gameplay-server.json'), 'utf8')) +
            (await readFile(join(artifacts, 'receipt.json'), 'utf8')),
          /socketSecret/u
        );
      }
    });
  });
}
for (const volume of [
  undefined,
  { status: 'pending', privateDetail: 'private-volume-detail' },
  { status: 'unavailable', sampledAt: 10000, errorCode: 'private-volume-detail' },
  {
    status: 'low',
    sampledAt: 10000,
    freeBytes: 1,
    databaseBytes: 12000000,
    walBytes: 4096,
    warningBytes: 384 * 1024 * 1024,
  },
]) {
  test(`volume evidence preserves diagnostic state ${volume?.status ?? 'missing'}`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket();
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp({
          world: {
            ...healthy,
            world: { ...healthy.world, persistence: { ...healthy.world.persistence, volume } },
          },
        }),
        createSocket: transport.createSocket,
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, true);
      const samples = receipt.observations
        .map(record)
        .filter((entry) => entry['source'] === 'server-health');
      assert.equal(samples.length, 2);
      for (const sample of samples) {
        assert.equal(record(sample['volume'])['status'], volume?.status ?? 'missing');
      }
      assert.doesNotMatch(
        await readFile(join(artifacts, 'receipt.json'), 'utf8'),
        /private-volume-detail/u
      );
      assert.equal(reports.length, 0);
    });
  });
}
for (const volume of [
  null,
  { status: 'unexpected', sampledAt: 10000, privateDetail: 'private-volume-detail' },
  { status: 'unavailable', sampledAt: -1 },
  { status: 'ok', sampledAt: 10000, freeBytes: -1, databaseBytes: 0, walBytes: 0, warningBytes: 1 },
  {
    status: 'ok',
    sampledAt: 10000,
    freeBytes: 1,
    databaseBytes: 0,
    walBytes: 0.5,
    warningBytes: 1,
  },
]) {
  test(`malformed volume diagnostics fail before gameplay ${JSON.stringify(volume)}`, async () => {
    await fixture(async (artifacts, reports) => {
      let launched = false;
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp({
          world: {
            ...healthy,
            world: { ...healthy.world, persistence: { ...healthy.world.persistence, volume } },
          },
        }),
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
        createSocket: () => {
          launched = true;
          throw new Error('Must not launch');
        },
      });
      assert.equal(receipt.success, false);
      assert.equal(launched, false);
      assert.deepEqual(receipt.errors, ['Malformed world volume diagnostics']);
      assert.doesNotMatch(
        await readFile(join(artifacts, 'receipt.json'), 'utf8'),
        /private-volume-detail/u
      );
    });
  });
}
for (const world of [
  { ...healthy, world: { ...healthy.world, persistence: { mode: 'memory', failed: false } } },
  { ...healthy, world: { ...healthy.world, persistence: { mode: 'worker', failed: true } } },
  { ...healthy, world: { ...healthy.world, loop: { stalls: 1 } } },
]) {
  test(`production health rejects coded invalid state ${JSON.stringify(world)}`, async () => {
    await fixture(async (artifacts, reports) => {
      let launched = false;
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp({ world }),
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
        createSocket: () => {
          launched = true;
          throw new Error('Must not launch');
        },
      });
      assert.equal(receipt.success, false);
      assert.equal(launched, false);
    });
  });
}
for (const options of [
  { assetsManifest: { releaseSha: release, gameplay: [], modules: {} } },
  {
    assetsManifest: {
      releaseSha: release,
      gameplay: ['assets/unreachable.js'],
      modules: { 'assets/game-coded.js': [], 'assets/unreachable.js': [] },
    },
  },
  {
    assetsManifest: {
      releaseSha: release,
      gameplay: ['assets/game-coded.js'],
      modules: { 'assets/game-coded.js': ['https://cdn.example/game.js'] },
    },
  },
  { assetType: 'text/html' },
  {
    html: '<html><canvas id="gameCanvas"></canvas><script type="module" src="https://cdn.example/game.js"></script></html>',
  },
  { html: '<html><script type="module" src="/assets/game-coded.js"></script></html>' },
]) {
  test(`client asset checks reject coded invalid or missing assets ${JSON.stringify(options)}`, async () => {
    const clock = controlledClock();
    await assert.rejects(
      waitForClientAssets({
        verifyHttp: clientHttp(options),
        clock,
        readinessMs: 100,
        pollMs: 10,
      }),
      /Client asset readiness deadline/u
    );
    assert.equal(clock.now(), 100);
  });
}

test('Astro entry reaches a dynamically imported gameplay chunk', async () => {
  const requests: string[] = [];
  const assetsManifest = {
    releaseSha: release,
    gameplay: ['_astro/engine.hash.js'],
    modules: { '_astro/page.hash.js': ['_astro/engine.hash.js'], '_astro/engine.hash.js': [] },
  };
  const http = clientHttp({
    assetsManifest,
    html: '<html><canvas id="gameCanvas"></canvas><script type="module" src="/_astro/page.hash.js"></script></html>',
  });
  const observed = await waitForClientAssets({
    verifyHttp: (url: string) => {
      requests.push(url);
      return url.endsWith('/page.hash.js')
        ? response(url, 'import("./engine.hash.js");', 'application/javascript')
        : http(url);
    },
    clock: controlledClock(),
    readinessMs: 100,
  });
  assert.deepEqual(observed, { assetCount: 2 });
  assert.ok(requests.some((url) => url.endsWith('/engine.hash.js')));
});

test('client assets poll within the original deadline when the graph is not yet available', async () => {
  let attempts = 0;
  const clock = controlledClock();
  const http = clientHttp();
  const verifyHttp = (url: string) => {
    if (url.endsWith('/client-assets.json') && ++attempts < 3) {
      throw new SmokeFailure('Client assets not available');
    }
    return http(url);
  };
  const observed = await waitForClientAssets({ verifyHttp, clock });
  assert.deepEqual(observed, { assetCount: 2 });
  assert.equal(clock.now(), 10000);
});

test('HTTP and behavior deadline races abort owned work and retain failed canonical receipts', async () => {
  await fixture(async (artifacts, reports) => {
    const clock = controlledClock();
    let started: () => void;
    const active = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let aborted = false;
    const run = runNetworkSmoke({
      scenario: {
        productionUrl,
        smoke: ({ signal }) => {
          started();
          return new Promise<never>((_, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(new SmokeFailure('Controlled scenario aborted'));
              },
              { once: true }
            )
          );
        },
      },
      env,
      fetcher: clientHttp(),
      clock,
      artifacts,
      report: (error) => reports.push(error),
    });
    await active;
    // The behavior call precedes timer creation by one synchronous frame.
    await Promise.resolve();
    clock.advance(240000);
    const receipt = await run;
    assert.equal(receipt.success, false);
    assert.ok(receipt.errors.includes('Behavior deadline exceeded'));
    assert.equal(aborted, true);
    assert.equal(clock.pending(), 0);
  });
  await fixture(async (artifacts, reports) => {
    const clock = controlledClock();
    let started: () => void;
    const active = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let aborted = false;
    const run = runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      readinessMs: 0,
      fetcher: (_url, { signal }) => {
        assert(signal);
        started();
        return new Promise<never>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('private-github-token'));
            },
            { once: true }
          )
        );
      },
      clock,
      artifacts,
      report: (error) => reports.push(error),
    });
    await active;
    clock.advance(15000);
    const receipt = await run;
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Readiness deadline exceeded']);
    assert.equal(reports.length, 1);
    assert.equal(cause(errorAt(reports, 0)).message, 'Production HTTP request deadline exceeded');
    assert.doesNotMatch(inspect(reports, { depth: 10 }), /private-github-token/u);
    assert.equal(aborted, true);
    assert.equal(clock.pending(), 0);
    assert.doesNotMatch(JSON.stringify(receipt), /private-github-token/u);
  });
});

test('verified HTTP rejects missing assets and noncanonical redirects before opening gameplay', async () => {
  for (const options of [
    { status: 404 },
    { redirect: 'https://other.example/private?token=private-github-token' },
  ]) {
    await fixture(async (artifacts, reports) => {
      let opened = false;
      const fetcher = clientHttp(options);
      const scenario = {
        productionUrl,
        smoke: (input: ScenarioContext) => smoke({ ...input, clientReadinessMs: 0 }),
      };
      const receipt = await runNetworkSmoke({
        scenario,
        env,
        fetcher,
        readinessMs: 0,
        clock: controlledClock(),
        artifacts,
        report: (error) => reports.push(error),
        createSocket: () => {
          opened = true;
          throw new Error('Must not launch');
        },
      });
      assert.equal(receipt.success, false);
      assert.equal(opened, false);
      assert.doesNotMatch(JSON.stringify(receipt), /other.example|private-github-token/u);
    });
  }
});

test('healthy persistence must survive the accepted shot', async () => {
  for (const changed of [
    { ...healthy, world: { ...healthy.world, persistence: { mode: 'worker', failed: true } } },
  ]) {
    await fixture(async (artifacts, reports) => {
      let healthChecks = 0;
      const transport = codedSocket();
      const fetcher = (url: string) =>
        clientHttp({ world: url.endsWith('/health') && ++healthChecks > 1 ? changed : healthy })(
          url
        );
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher,
        clock: controlledClock(),
        createSocket: transport.createSocket,
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, false);
      assert.equal(healthChecks, 2);
      const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(record(evidence['shot'])['acknowledged'], true);
      assert.equal(evidence['socketClosed'], true);
    });
  }
});

test('an aborted gameplay behavior closes its current socket and awaits cleanup before returning', async () => {
  await fixture(async (artifacts, reports) => {
    const clock = controlledClock(),
      transport = codedSocket();
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock,
      createSocket: transport.createSocket,
      artifacts,
      report: (error) => reports.push(error),
      behaviorMs: 1,
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Behavior deadline exceeded']);
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence['socketClosed'], true);
    assert.equal(evidence['shot'], null);
    assert.equal(clock.pending(), 0);
  });
});

test('forced socket termination is retained as failed cleanup even after a successful accepted shot', async () => {
  await fixture(async (artifacts, reports) => {
    const clock = controlledClock(),
      transport = codedSocket('close-timeout');
    let started: () => void;
    const closing = new Promise<void>((resolveClosing) => {
      started = resolveClosing;
    });
    const createSocket = (...args: Parameters<ReturnType<typeof codedSocket>['createSocket']>) => {
      const socket = transport.createSocket(...args);
      socket.once('close-requested', started);
      return socket;
    };
    const run = runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock,
      createSocket,
      artifacts,
      report: (error) => reports.push(error),
    });
    await closing;
    clock.advance(9000);
    const receipt = await run;
    assert.equal(receipt.success, false);
    assert.ok(receipt.errors.includes('Owned gameplay socket required forced termination'));
    const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence['socketClosed'], true);
    assert.equal(record(evidence['shot'])['acknowledged'], true);
    assert.equal(evidence['cleanupError'], 'Owned gameplay socket required forced termination');
    assert.equal(clock.pending(), 0);
  });
});

for (const metadata of [
  { manifest: oldRelease, bundleSource: 'console.log("gameplay without embedded SHA");' },
  { world: { ...healthy, releaseId: undefined } },
]) {
  test(`healthy gameplay passes independently of descriptive release metadata ${JSON.stringify(metadata)}`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket('stale-server');
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(metadata),
        clock: controlledClock(),
        createSocket: transport.createSocket,
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, true);
      assert.deepEqual(receipt.errors, []);
      const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence['serverReleaseId'], oldRelease);
      assert.equal(record(evidence['shot'])['acknowledged'], true);
      assert.equal(evidence['socketClosed'], true);
    });
  });
}

test('a transport error during owned close cannot turn into a successful receipt', async () => {
  await fixture(async (artifacts, reports) => {
    const transport = codedSocket('error-on-close');
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock: controlledClock(),
      createSocket: transport.createSocket,
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, false);
    assert.ok(receipt.errors.includes('Gameplay socket transport failed'));
    assert.equal(reports.length, 1);
    assert.equal(errorAt(reports, 0).cause, transport.failure);
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    assert.doesNotMatch(JSON.stringify(receipt), /private-resume-token/u);
  });
});

for (const closeCode of [1006, 1011]) {
  test(`owned socket close ${closeCode} alone rejects an otherwise accepted production session`, async () => {
    await fixture(async (artifacts, reports) => {
      const transport = codedSocket(`close-only-${closeCode}`),
        clock = controlledClock();
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        clock,
        createSocket: transport.createSocket,
        artifacts,
        report: (error) => reports.push(error),
      });
      assert.equal(receipt.success, false);
      assert.deepEqual(receipt.errors, ['Owned gameplay socket closed abnormally']);
      const evidence = parseRecord(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(record(evidence['shot'])['acknowledged'], true);
      assert.equal(evidence['socketClosed'], true);
      assert.equal(evidence['closeCode'], closeCode);
      assert.equal(evidence['cleanupError'], 'Owned gameplay socket closed abnormally');
      assert.equal(clock.pending(), 0);
      assert.equal(transport.socket().readyState, WebSocket.CLOSED);
      assert.doesNotMatch(
        JSON.stringify(receipt) + JSON.stringify(evidence),
        /private-resume-token|private-github-token/u
      );
    });
  });
}

test('an unexpected application error is reported once and leaves the public receipt generic', async () => {
  await fixture(async (artifacts, reports) => {
    const failure = new TypeError('Controlled application failure');
    const receipt = await runNetworkSmoke({
      scenario: {
        productionUrl,
        smoke: () => Promise.reject(failure),
      },
      env,
      fetcher: clientHttp(),
      clock: controlledClock(),
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Production verification failed']);
    assert.deepEqual(reports, [failure]);
    assert.deepEqual(parseJson(await readFile(join(artifacts, 'receipt.json'), 'utf8')), receipt);
  });
});

test('a non-Error throw is reported without exposing its arbitrary fields', async () => {
  await fixture(async (artifacts, reports) => {
    const receipt = await runNetworkSmoke({
      scenario: {
        productionUrl,
        smoke: () => Promise.reject({ token: 'nonErrorSecret' }),
      },
      env,
      fetcher: clientHttp(),
      clock: controlledClock(),
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Production verification failed']);
    assert.equal(reports.length, 1);
    assert.equal(errorAt(reports, 0) instanceof Error, true);
    assert.equal(errorAt(reports, 0).message, 'Unexpected non-Error smoke failure');
    assert.doesNotMatch(
      inspect(reports, { depth: 10 }) + JSON.stringify(receipt),
      /nonErrorSecret/u
    );
  });
});

test('readiness retains a safe immediate transport cause through the deadline boundary', async () => {
  await fixture(async (artifacts, reports) => {
    const failure = new Error('Controlled ECONNRESET from production transport');
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: () => Promise.reject(failure),
      readinessMs: 0,
      clock: controlledClock(),
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Readiness deadline exceeded']);
    assert.equal(reports.length, 1);
    assert.equal(cause(errorAt(reports, 0)).message, 'Production HTTP request failed');
    assert.equal(cause(errorAt(reports, 0)).cause, failure);
    assert.doesNotMatch(await readFile(join(artifacts, 'receipt.json'), 'utf8'), /ECONNRESET/u);
  });
});

test('malformed HTTP JSON never exposes its body through reports or retained artifacts', async () => {
  await fixture(async (artifacts, reports) => {
    const http = clientHttp();
    const clock = controlledClock();
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: (url) =>
        url.endsWith('/health') ? Promise.resolve(response(url, 'httpSecret')) : http(url),
      clock,
      artifacts,
      report: (error) => reports.push(error),
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Production HTTP body failed or timed out']);
    assert.equal(reports.length, 1);
    assert.equal(cause(errorAt(reports, 0)).message, 'Production HTTP JSON parsing failed');
    assert.doesNotMatch(
      inspect(reports, { depth: 10 }) +
        (await readFile(join(artifacts, 'receipt.json'), 'utf8')) +
        (await readFile(join(artifacts, 'gameplay-server.json'), 'utf8')),
      /httpSecret/u
    );
    assert.equal(clock.pending(), 0);
  });
});

for (const expectedAbort of [false, true]) {
  test(`late behavior cleanup ${expectedAbort ? 'suppresses its expected abort' : 'reports its distinct failure'}`, async () => {
    await fixture(async (artifacts, reports) => {
      const clock = controlledClock();
      const failure = expectedAbort
        ? new DOMException('Owned behavior cancelled', 'AbortError')
        : new Error('Controlled late cleanup failure');
      let started: () => void;
      const active = new Promise<void>((resolveStarted) => {
        started = resolveStarted;
      });
      const run = runNetworkSmoke({
        scenario: {
          productionUrl,
          smoke: ({ signal }) => {
            started();
            return new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => reject(failure), { once: true })
            );
          },
        },
        env,
        fetcher: clientHttp(),
        clock,
        artifacts,
        behaviorMs: 1,
        report: (error) => reports.push(error),
      });
      await active;
      await Promise.resolve();
      clock.advance(1);
      const receipt = await run;
      assert.equal(receipt.success, false);
      assert.deepEqual(receipt.errors, ['Behavior deadline exceeded']);
      assert.deepEqual(reports, expectedAbort ? [] : [failure]);
      assert.equal(clock.pending(), 0);
    });
  });
}
