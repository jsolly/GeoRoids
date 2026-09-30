import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { verifyAncestry } from './production-smoke.mjs';
import { productionUrl, smoke } from './production-smoke-scenario.mjs';

const sha = 'a'.repeat(40);
const healthyWorld = { persistence: { mode: 'worker', failed: false }, loop: { stalls: 0 } };

for (const world of [
  { ...healthyWorld, persistence: { mode: 'memory', failed: false } },
  { ...healthyWorld, persistence: { mode: 'worker', failed: true } },
  { ...healthyWorld, loop: { stalls: 1 } },
]) {
  test(`production smoke rejects unhealthy world ${JSON.stringify(world)}`, async () => {
    await assert.rejects(
      smoke({
        verifyAncestry,
        expectedServerSha: sha,
        verifyRelease: (_url, minimum) => {
          assert.equal(minimum, sha);
          return { json: async () => ({ world }) };
        },
      }),
      /Persistent world|Game loop/u
    );
  });
}

test('Enter Game without a successful multiplayer join fails production smoke', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300);
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<label>Your Nickname<input></label><button>Enter Game</button>',
      })
    );
    await page.goto(productionUrl);
    await assert.rejects(
      smoke({
        verifyAncestry,
        page,
        expectedServerSha: sha,
        verifyRelease: async () => ({ json: async () => ({ world: healthyWorld }) }),
      }),
      /Timeout/u
    );
  } finally {
    await browser.close();
  }
});

const { execFileSync } = await import('node:child_process');
const { EventEmitter } = await import('node:events');
const { mkdtemp, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const release = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const previous = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();

for (const failure of [
  'wrong-host',
  'insecure-socket',
  'stale-server',
  'invalid-snapshot',
  'snapshot-before-join',
]) {
  test(`actual gameplay connection rejects ${failure} and retains evidence`, async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'georoids-smoke-'));
    const page = new EventEmitter();
    const socket = new EventEmitter();
    socket.url = () =>
      failure === 'wrong-host'
        ? 'wss://other.example/ws'
        : `${failure === 'insecure-socket' ? 'ws' : 'wss'}://georoids-production-2403.up.railway.app/ws`;
    page.getByLabel = () => ({ fill: () => Promise.resolve() });
    page.getByRole = () => ({
      click: () => {
        page.emit('websocket', socket);
        if (failure !== 'snapshot-before-join') {
          socket.emit('framereceived', {
            payload: JSON.stringify({
              type: 'joined',
              data: {
                id: 'pilot',
                snapshotVersion: 1,
                asteroidInteractions: 1,
                serverReleaseId: failure === 'stale-server' ? previous : release,
              },
            }),
          });
        }
        if (failure === 'invalid-snapshot' || failure === 'snapshot-before-join') {
          socket.emit('framereceived', {
            payload: JSON.stringify({
              type: 'snapshot',
              data: {
                version: 999,
                sequence: 1,
                kind: 'keyframe',
                state: { entities: [{ id: 'pilot', position: { x: 0, y: 0 } }] },
              },
            }),
          });
        }
        return Promise.resolve();
      },
    });
    page.waitForFunction = () => Promise.resolve();
    page.evaluate = () => Promise.resolve('pilot');
    try {
      await assert.rejects(
        smoke({
          verifyAncestry,
          page,
          artifacts,
          expectedServerSha: release,
          verifyRelease: () => ({ json: () => Promise.resolve({ world: healthyWorld }) }),
        }),
        /Unexpected gameplay|merge-base|malformed snapshot|before the current protocol join/u
      );
      const evidence = JSON.parse(await readFile(join(artifacts, 'gameplay-server.json'), 'utf8'));
      assert.equal(evidence.minimumServerRelease, release);
      assert.equal(evidence.sockets[0].url, socket.url());
      assert.equal(evidence.acceptedSnapshots, 0);
      assert.ok(evidence.error);
      if (failure === 'stale-server') {
        assert.equal(evidence.sockets[0].serverReleaseId, previous);
      }
    } finally {
      await rm(artifacts, { recursive: true, force: true });
    }
  });
}

const { tsImport } = await import('tsx/esm/api');
const { SnapshotEncoder } = await tsImport('../shared/snapshotProtocol.ts', import.meta.url);
const { snapshotFixture } = await tsImport(
  '../tests/unit/network/snapshotFixture.ts',
  import.meta.url
);

// Only this test transport emits packets. Production observes the real page's sockets and keys.
function firingPage(outcome) {
  const page = new EventEmitter();
  const socket = new EventEmitter();
  socket.url = () => 'wss://georoids-production-2403.up.railway.app/ws';
  const receive = (target, type, data) =>
    target.emit('framereceived', { payload: JSON.stringify({ type, data }) });
  const acknowledge = (target = socket, data = { requestId: 'ui-shot', projectileId: 'bolt' }) =>
    receive(target, 'shotAcknowledged', data);
  let sequence = 0;
  let baseline;
  const snapshot = (tick) => {
    const encoder = new SnapshotEncoder(snapshotFixture(tick));
    const frame = encoder.encode(++sequence, baseline);
    baseline = { sequence, state: encoder.state };
    receive(socket, 'snapshot', frame);
  };
  page.getByLabel = () => ({ fill: async () => {} });
  page.getByRole = () => ({
    click: () => {
      page.emit('websocket', socket);
      receive(socket, 'joined', {
        id: 'pilot-0',
        snapshotVersion: 1,
        asteroidInteractions: 1,
        serverReleaseId: release,
      });
      if (outcome === 'stale-before-window') {
        socket.emit('framesent', {
          payload: JSON.stringify({
            type: 'shoot',
            id: 'pilot-0',
            data: {
              laserStart: { x: 0, y: 0 },
              laserDirection: { x: 5, y: 0 },
              requestId: 'ui-shot',
            },
          }),
        });
        acknowledge();
      }
      snapshot(0);
      snapshot(1);
    },
  });
  page.waitForFunction = async () => {};
  page.evaluate = async () => 'pilot-0';
  page.keyboard = {
    up: (key) => {
      if (key === 'Space' && outcome === 'malformed-on-keyup') {
        socket.emit('framereceived', { payload: '{broken' });
      }
    },
    down: (key) => {
      if (key === 'ArrowRight') {
        snapshot(20);
        return;
      }
      assert.equal(key, 'Space');
      socket.emit('framesent', {
        payload: JSON.stringify({
          type: 'shoot',
          id: outcome === 'wrong-player' ? 'pilot-other' : 'pilot-0',
          data: {
            laserStart: { x: 0, y: 0 },
            laserDirection: { x: 5, y: 0 },
            requestId: 'ui-shot',
          },
        }),
      });
      if (outcome === 'accepted-immediate-collision' || outcome === 'malformed-on-keyup') {
        acknowledge();
        snapshot(21); // No projectile survives into this decoded delta.
      } else if (outcome === 'null') {
        acknowledge(socket, { requestId: 'ui-shot', projectileId: null });
      } else if (outcome === 'wrong-request') {
        acknowledge(socket, { requestId: 'old-shot', projectileId: 'bolt' });
      } else if (outcome === 'wrong-socket') {
        const other = new EventEmitter();
        other.url = socket.url;
        page.emit('websocket', other);
        acknowledge(other);
      } else if (outcome === 'malformed-projectile') {
        acknowledge(socket, { requestId: 'ui-shot', projectileId: 42 });
      } else if (outcome === 'missing-projectile') {
        acknowledge(socket, { requestId: 'ui-shot' });
      } else if (outcome === 'missing-request') {
        acknowledge(socket, { projectileId: 'bolt' });
      }
    },
  };
  return page;
}

test('real firing evidence requires its socket, player, request and accepted acknowledgement', {
  concurrency: true,
}, async (t) => {
  await Promise.all(
    [
      'accepted-immediate-collision',
      'null',
      'missing',
      'wrong-request',
      'wrong-socket',
      'wrong-player',
      'stale-before-window',
      'malformed-projectile',
      'missing-projectile',
      'missing-request',
      'malformed-on-keyup',
    ].map((outcome) =>
      t.test(outcome, async () => {
        const artifacts = await mkdtemp(join(tmpdir(), 'georoids-firing-'));
        try {
          const run = smoke({
            page: firingPage(outcome),
            artifacts,
            verifyAncestry,
            expectedServerSha: release,
            verifyRelease: async () => ({ json: async () => ({ world: healthyWorld }) }),
          });
          if (outcome === 'accepted-immediate-collision') {
            await run;
          } else {
            await assert.rejects(
              run,
              /accepted shot acknowledgement|another player|Malformed shot acknowledgement|JSON/u
            );
          }
          const evidence = JSON.parse(
            await readFile(join(artifacts, 'gameplay-server.json'), 'utf8')
          );
          assert.ok(evidence.acceptedSnapshots >= 3);
          if (outcome === 'accepted-immediate-collision') {
            assert.deepEqual(evidence.sockets[0].shots, [
              { playerId: 'pilot-0', requestId: 'ui-shot', projectileId: 'bolt' },
            ]);
            assert.equal(evidence.error, undefined);
          } else {
            assert.ok(evidence.error);
            if (outcome !== 'malformed-on-keyup') {
              assert.ok(
                evidence.sockets.every((connection) =>
                  connection.shots.every((shot) => shot.projectileId === null)
                )
              );
            }
          }
        } finally {
          await rm(artifacts, { recursive: true, force: true });
        }
      })
    )
  );
});
