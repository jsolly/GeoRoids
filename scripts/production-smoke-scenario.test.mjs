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
        : `${failure === 'insecure-socket' ? 'ws' : 'wss'}://geoasteroids-production-2403.up.railway.app/ws`;
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
