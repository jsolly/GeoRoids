import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tsImport } from 'tsx/esm/api';
import WebSocket from 'ws';
import { runNetworkSmoke, SmokeFailure } from './production-smoke-network.mjs';
import { productionUrl, smoke, waitForClientRelease } from './production-smoke-scenario.mjs';

const { decodeClientCommand } = await tsImport(
  '../server/communication/clientCommandDecoder.ts',
  import.meta.url
);
const { SnapshotEncoder } = await tsImport('../shared/snapshotProtocol.ts', import.meta.url);
const { snapshotFixture } = await tsImport(
  '../tests/unit/network/snapshotFixture.ts',
  import.meta.url
);
const release = 'a'.repeat(40),
  oldRelease = 'b'.repeat(40);
const healthy = {
  releaseId: release,
  world: { persistence: { mode: 'worker', failed: false }, loop: { stalls: 0 } },
};
const env = {
  PRODUCTION_SMOKE_REQUEST_ID: 'coded-smoke',
  PRODUCTION_SMOKE_RELEASE_SHA: release,
  PRODUCTION_SMOKE_SERVER_SHA: release,
  PRODUCTION_SMOKE_GITHUB_TOKEN: 'private-github-token',
};

function controlledClock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  const advance = (ms) => {
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
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      advance(ms);
      await Promise.resolve();
      signal?.throwIfAborted();
    },
    setTimeout: (callback, ms) => {
      const id = ++next;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance,
    pending: () => timers.size,
  };
}
function response(url, body, type = 'application/json', status = 200) {
  const result = new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
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
} = {}) {
  return (url) => {
    let result;
    if (url.endsWith('/release.json')) {
      result = response(url, { releaseSha: manifest });
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
    if (redirect) {
      Object.defineProperty(result, 'url', { value: redirect });
    }
    return Promise.resolve(result);
  };
}
function codedSocket(outcome = 'accepted') {
  let socket,
    sent = [];
  const createSocket = (url, options) => {
    assert.equal(
      url,
      'wss://georoids-production-2403.up.railway.app/ws?snapshotVersion=2&asteroidInteractions=1'
    );
    assert.equal(options.origin, new URL(productionUrl).origin);
    assert.equal(options.handshakeTimeout, 15000);
    socket = new EventEmitter();
    socket.readyState = WebSocket.CONNECTING;
    let id,
      sequence = 0,
      baseline,
      player;
    const receive = (type, data) =>
      socket.emit('message', Buffer.from(JSON.stringify({ type, data })));
    const snapshot = () => {
      const state = snapshotFixture();
      state.entities = [player];
      const encoder = new SnapshotEncoder(state),
        frame = encoder.encode(++sequence, baseline);
      baseline = { sequence, state: encoder.state };
      receive('snapshot', frame);
    };
    socket.send = (text) => {
      const message = JSON.parse(text);
      assert.equal(
        decodeClientCommand(message).ok,
        true,
        'Smoke requests must satisfy the current server command decoder'
      );
      sent.push(message);
      if (message.type === 'join') {
        id = message.id;
        assert.equal(message.data.snapshotVersion, 2);
        assert.equal(message.data.asteroidInteractions, 1);
        assert.equal(message.data.clientReleaseId, release);
        assert.equal(message.data.resumeToken, undefined);
        player = {
          ...snapshotFixture().entities[0],
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
          snapshotVersion: outcome === 'old-protocol' ? 1 : 2,
          asteroidInteractions: 1,
          shotAcknowledgements: true,
          resumeToken: 'private-resume-token',
          serverReleaseId: outcome === 'stale-server' ? oldRelease : release,
        });
        if (outcome === 'malformed-snapshot') {
          receive('snapshot', { version: 999 });
          return;
        }
        snapshot();
        if (outcome !== 'missing-second-snapshot') {
          snapshot();
        }
      } else if (message.type === 'update') {
        const data = message.data;
        assert.equal(data.motionEpoch, 1);
        assert.equal(data.motionSequence, 1);
        player = {
          ...player,
          position: data.position,
          velocity: data.velocity,
          angle: data.angle,
          playerMotion: {
            epoch: outcome === 'wrong-motion-epoch' ? 2 : 1,
            ack: outcome === 'missing-motion-ack' ? 0 : data.motionSequence,
            mode: 'free',
          },
        };
        if (outcome === 'no-movement') {
          player.position = { x: 0, y: 0 };
        }
        snapshot();
      } else if (message.type === 'shoot') {
        assert.equal(message.id, id);
        assert.equal(typeof message.data.requestId, 'string');
        assert.ok(message.data.laserDirection.x > 0);
        if (outcome === 'missing-shot-ack') {
          return;
        }
        receive('shotAcknowledged', {
          requestId: outcome === 'wrong-shot-request' ? 'other-request' : message.data.requestId,
          projectileId:
            outcome === 'rejected-shot'
              ? null
              : outcome === 'malformed-shot-ack'
                ? 42
                : 'accepted-bolt',
        });
      }
    };
    socket.close = (code) => {
      assert.equal(code, 1000);
      if (outcome === 'close-timeout') {
        socket.emit('close-requested');
        return;
      }
      if (outcome === 'error-on-close') {
        socket.emit('error', new Error('private-resume-token'));
      }
      socket.readyState = WebSocket.CLOSED;
      socket.emit(
        'close',
        outcome === 'close-only-1006' ? 1006 : outcome === 'close-only-1011' ? 1011 : 1000,
        Buffer.from('private-resume-token')
      );
    };
    socket.terminate = () => {
      socket.readyState = WebSocket.CLOSED;
      socket.emit('close', 1006);
    };
    queueMicrotask(() => {
      socket.readyState = WebSocket.OPEN;
      socket.emit('open');
      if (outcome === 'transport-failure') {
        socket.emit('error', new Error('private-resume-token'));
      }
    });
    return socket;
  };
  return { createSocket, socket: () => socket, sent: () => sent };
}
async function fixture(run) {
  const artifacts = await mkdtemp(join(tmpdir(), 'georoids-coded-smoke-'));
  try {
    await run(artifacts);
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
}

test('the deployed HTTP release and genuine current-protocol gameplay produce a canonical receipt without private credentials', async () => {
  await fixture(async (artifacts) => {
    const transport = codedSocket(),
      clock = controlledClock();
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock,
      createSocket: transport.createSocket,
      artifacts,
    });
    assert.equal(receipt.success, true);
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.requestId, env.PRODUCTION_SMOKE_REQUEST_ID);
    assert.equal(receipt.releaseSha, release);
    assert.equal(clock.pending(), 0);
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    assert.ok(transport.sent().filter((message) => message.type === 'snapshotAck').length >= 3);
    assert.equal(transport.sent().at(-1).type, 'leave');
    const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence.acceptedSnapshots, 3);
    assert.equal(evidence.admission.snapshotVersion, 2);
    assert.match(evidence.admission.playerId, /^smoke-/u);
    assert.equal(evidence.movement.acknowledged, 1);
    assert.equal(evidence.movement.displacement, 6);
    assert.equal(evidence.shot.projectileId, 'accepted-bolt');
    assert.equal(evidence.socketClosed, true);
    assert.equal(evidence.closeCode, 1000);
    const retained = JSON.stringify(receipt) + JSON.stringify(evidence);
    assert.doesNotMatch(
      retained,
      /private-resume-token|private-github-token|resumeToken|authorization/u
    );
    assert.deepEqual(JSON.parse(await readFile(join(artifacts, 'receipt.json'), 'utf8')), receipt);
  });
});

for (const outcome of [
  'wrong-player',
  'old-protocol',
  'stale-server',
  'snapshot-before-join',
  'malformed-snapshot',
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
    await fixture(async (artifacts) => {
      const transport = codedSocket(outcome),
        clock = controlledClock();
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        clock,
        createSocket: transport.createSocket,
        artifacts,
      });
      assert.equal(receipt.success, false);
      assert.ok(receipt.errors.length > 0);
      assert.equal(transport.socket().readyState, WebSocket.CLOSED);
      assert.equal(clock.pending(), 0);
      assert.doesNotMatch(JSON.stringify(receipt), /private-resume-token|private-github-token/u);
      const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence.socketClosed, true);
      assert.ok(evidence.error);
    });
  });
}
for (const world of [
  { ...healthy, releaseId: oldRelease },
  { ...healthy, world: { ...healthy.world, persistence: { mode: 'memory', failed: false } } },
  { ...healthy, world: { ...healthy.world, persistence: { mode: 'worker', failed: true } } },
  { ...healthy, world: { ...healthy.world, loop: { stalls: 1 } } },
]) {
  test(`production health rejects coded invalid state ${JSON.stringify(world)}`, async () => {
    await fixture(async (artifacts) => {
      let launched = false;
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp({ world }),
        clock: controlledClock(),
        artifacts,
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
  { manifest: oldRelease },
  { bundle: oldRelease },
  { bundleSource: `const env = { VITE_COMMIT_SHA: \`${oldRelease}\` };` },
  { bundleSource: `const env = { VITE_COMMIT_SHA: "${release}' };` },
  { bundleSource: `const env = { VITE_COMMIT_SHA: \`${release}\${suffix}\` };` },
  { assetType: 'text/html' },
  {
    html: '<html><canvas id="gameCanvas"></canvas><script type="module" src="https://cdn.example/game.js"></script></html>',
  },
  { html: '<html><script type="module" src="/assets/game-coded.js"></script></html>' },
]) {
  test(`client release rejects coded stale or missing bundle ${JSON.stringify(options)}`, async () => {
    const clock = controlledClock();
    await assert.rejects(
      waitForClientRelease({
        expectedSha: release,
        verifyHttp: clientHttp(options),
        clock,
        readinessMs: 100,
        pollMs: 10,
      }),
      /Client release readiness deadline/u
    );
    assert.equal(clock.now(), 100);
  });
}

for (const quote of ['"', "'", '`']) {
  test(`client release accepts the deployed identity in a ${quote} JavaScript literal`, async () => {
    const clock = controlledClock();
    const observed = await waitForClientRelease({
      expectedSha: release,
      verifyHttp: clientHttp({
        bundleSource: `const env = { VITE_COMMIT_SHA: ${quote}${release}${quote} };`,
      }),
      clock,
      readinessMs: 100,
      pollMs: 10,
    });
    assert.deepEqual(observed, { releaseSha: release, assetCount: 2 });
    assert.equal(clock.now(), 0);
  });
}

test('client propagation polls within its original deadline and binds the deployed entry bundle', async () => {
  let attempts = 0;
  const clock = controlledClock();
  const verifyHttp = async (url) =>
    clientHttp({
      manifest: url.endsWith('/release.json') && ++attempts < 3 ? oldRelease : release,
    })(url);
  const observed = await waitForClientRelease({ expectedSha: release, verifyHttp, clock });
  assert.deepEqual(observed, { releaseSha: release, assetCount: 2 });
  assert.equal(clock.now(), 10000);
});

test('HTTP and behavior deadline races abort owned work and retain failed canonical receipts', async () => {
  await fixture(async (artifacts) => {
    const clock = controlledClock();
    let started;
    const active = new Promise((resolveStarted) => {
      started = resolveStarted;
    });
    let aborted = false;
    const run = runNetworkSmoke({
      scenario: {
        productionUrl,
        smoke: ({ signal }) => {
          started();
          return new Promise((_, reject) =>
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
  await fixture(async (artifacts) => {
    const clock = controlledClock();
    let started;
    const active = new Promise((resolveStarted) => {
      started = resolveStarted;
    });
    let aborted = false;
    const run = runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      readinessMs: 0,
      fetcher: (_url, { signal }) => {
        started();
        return new Promise((_, reject) =>
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
    });
    await active;
    clock.advance(15000);
    const receipt = await run;
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Readiness deadline exceeded']);
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
    await fixture(async (artifacts) => {
      let opened = false;
      const fetcher = clientHttp(options);
      const scenario = {
        productionUrl,
        smoke: (input) => smoke({ ...input, clientReadinessMs: 0 }),
      };
      const receipt = await runNetworkSmoke({
        scenario,
        env,
        fetcher,
        readinessMs: 0,
        clock: controlledClock(),
        artifacts,
        createSocket: () => {
          opened = true;
        },
      });
      assert.equal(receipt.success, false);
      assert.equal(opened, false);
      assert.doesNotMatch(JSON.stringify(receipt), /other.example|private-github-token/u);
    });
  }
});

test('healthy persistence must survive the accepted shot and remain on the same verified release', async () => {
  for (const changed of [
    { ...healthy, world: { ...healthy.world, persistence: { mode: 'worker', failed: true } } },
    { ...healthy, releaseId: oldRelease },
  ]) {
    await fixture(async (artifacts) => {
      let healthChecks = 0;
      const transport = codedSocket();
      const fetcher = (url) =>
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
      });
      assert.equal(receipt.success, false);
      assert.equal(healthChecks, 2);
      const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence.shot.acknowledged, true);
      assert.equal(evidence.socketClosed, true);
    });
  }
});

test('an aborted gameplay behavior closes its current socket and awaits cleanup before returning', async () => {
  await fixture(async (artifacts) => {
    const clock = controlledClock(),
      transport = codedSocket();
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock,
      createSocket: transport.createSocket,
      artifacts,
      behaviorMs: 1,
    });
    assert.equal(receipt.success, false);
    assert.deepEqual(receipt.errors, ['Behavior deadline exceeded']);
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence.socketClosed, true);
    assert.equal(evidence.shot, null);
    assert.equal(clock.pending(), 0);
  });
});

test('forced socket termination is retained as failed cleanup even after a successful accepted shot', async () => {
  await fixture(async (artifacts) => {
    const clock = controlledClock(),
      transport = codedSocket('close-timeout');
    let started;
    const closing = new Promise((resolveClosing) => {
      started = resolveClosing;
    });
    const createSocket = (...args) => {
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
    });
    await closing;
    clock.advance(9000);
    const receipt = await run;
    assert.equal(receipt.success, false);
    assert.ok(receipt.errors.includes('Owned gameplay socket required forced termination'));
    const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
    assert.equal(evidence.socketClosed, true);
    assert.equal(evidence.shot.acknowledged, true);
    assert.equal(evidence.cleanupError, 'Owned gameplay socket required forced termination');
    assert.equal(clock.pending(), 0);
  });
});

test('client-only releases derive the server minimum and bind both health checks and join to its verified ancestry', async () => {
  await fixture(async (artifacts) => {
    const transport = codedSocket(),
      clock = controlledClock();
    const checked = [];
    const scenario = {
      productionUrl,
      smoke: (input) =>
        smoke({
          ...input,
          resolveServerMinimum: (client) => {
            assert.equal(client, release);
            return release;
          },
          verifyAncestry: (minimum, observed) => {
            assert.equal(minimum, release);
            assert.equal(observed, release);
            checked.push(observed);
          },
        }),
    };
    const receipt = await runNetworkSmoke({
      scenario,
      env: {
        PRODUCTION_SMOKE_REQUEST_ID: 'coded-client-only',
        PRODUCTION_SMOKE_RELEASE_SHA: release,
      },
      fetcher: clientHttp(),
      clock,
      createSocket: transport.createSocket,
      artifacts,
    });
    assert.equal(receipt.success, true);
    assert.equal(checked.length, 3);
  });
});

test('a transport error during owned close cannot turn into a successful receipt', async () => {
  await fixture(async (artifacts) => {
    const transport = codedSocket('error-on-close');
    const receipt = await runNetworkSmoke({
      scenario: { productionUrl, smoke },
      env,
      fetcher: clientHttp(),
      clock: controlledClock(),
      createSocket: transport.createSocket,
      artifacts,
    });
    assert.equal(receipt.success, false);
    assert.ok(receipt.errors.includes('Gameplay socket transport failed'));
    assert.equal(transport.socket().readyState, WebSocket.CLOSED);
    assert.doesNotMatch(JSON.stringify(receipt), /private-resume-token/u);
  });
});

for (const closeCode of [1006, 1011]) {
  test(`owned socket close ${closeCode} alone rejects an otherwise accepted production session`, async () => {
    await fixture(async (artifacts) => {
      const transport = codedSocket(`close-only-${closeCode}`),
        clock = controlledClock();
      const receipt = await runNetworkSmoke({
        scenario: { productionUrl, smoke },
        env,
        fetcher: clientHttp(),
        clock,
        createSocket: transport.createSocket,
        artifacts,
      });
      assert.equal(receipt.success, false);
      assert.deepEqual(receipt.errors, ['Owned gameplay socket closed abnormally']);
      const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence.shot.acknowledged, true);
      assert.equal(evidence.socketClosed, true);
      assert.equal(evidence.closeCode, closeCode);
      assert.equal(evidence.cleanupError, 'Owned gameplay socket closed abnormally');
      assert.equal(clock.pending(), 0);
      assert.equal(transport.socket().readyState, WebSocket.CLOSED);
      assert.doesNotMatch(
        JSON.stringify(receipt) + JSON.stringify(evidence),
        /private-resume-token|private-github-token/u
      );
    });
  });
}
