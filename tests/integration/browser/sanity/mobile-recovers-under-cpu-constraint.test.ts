// @vitest-environment node
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { JSHandle } from 'playwright';
import { expect, test } from 'vitest';
import type { ConnectionManager } from '../../../../src/network/services/ConnectionManager';
import { watchGpuPilotSnapshots } from '../../../support/gpu-gameplay-observation';
import {
  attemptScenarioCleanup,
  createNativeLifecycleBrowser,
  readWireCounters,
  withScenarioCleanup,
} from '../../../support/native-lifecycle-browser';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { withFixtureEvidence } from '../../utils/fixture-evidence';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';
import {
  canvasPoint,
  centerOf,
  dispatchTouch,
  readTouchControlState,
} from '../../utils/touch-input';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('a constrained mobile pilot releases controls, resumes a frozen page, reconnects, and detects injected rendering work', async () => {
  await browserManager.closeAllPages();
  const native = await createNativeLifecycleBrowser({ width: 390, height: 844, hasTouch: true });
  const { page, session } = native;
  let touching = false;
  let freezeConnection: JSHandle<ConnectionManager> | undefined;
  let freezeSocket: JSHandle<WebSocket | null> | undefined;
  let captureEvidence: () => Promise<unknown> = () => Promise.resolve(null);
  let retainedEvidence: () => unknown = () => ({ nativeHost: native.diagnostics() });
  async function runScene(stage: (name: string) => Promise<void>): Promise<void> {
    await withScenarioCleanup(
      async () => {
        const peerPage = await browserManager.createAdditionalPage();
        const primaryDiagnostics = watchBrowserDiagnostics(page);
        const peerDiagnostics = watchBrowserDiagnostics(peerPage);
        const pilotWire = watchGpuPilotSnapshots(page);
        const peerWire = watchGpuPilotSnapshots(peerPage);
        captureEvidence = () =>
          Promise.resolve({
            primaryWire: readWireCounters(pilotWire),
            peerWire: readWireCounters(peerWire),
          });
        const game = new GameInteractions(page);
        const peer = new GameInteractions(peerPage);
        async function join(pilot: GameInteractions, pilotPage: typeof page, name: string) {
          await pilotPage.goto(`${TestConfig.GAME_URL}/?performance=collect`);
          await pilotPage.locator('#playerNameInput').fill(name);
          await pilot.startGame();
          await pilot.waitForGameReady();
          await pilot.waitForServerJoin();
          await pilotPage.evaluate(() => {
            const collection = document.querySelector<HTMLElement>(
              '[aria-label="Performance collection"]'
            );
            if (collection) {
              collection.hidden = true;
            }
          });
        }
        await join(game, page, 'Constrained mobile');
        const pilotId = await game.getLocalPlayerId();
        await arrangeCrewField([pilotId], 'empty');
        await join(peer, peerPage, 'Mobile crew');
        const peerId = await peer.getLocalPlayerId();
        expect(peerId).not.toBe(pilotId);
        expect(peerPage.context()).not.toBe(page.context());
        const epochs = await arrangeCrewField([pilotId, peerId], 'empty');
        for (const [pilot, id, x] of [
          [game, pilotId, 0],
          [peer, peerId, 120],
        ] as const) {
          await pilot.waitForControlledFixture(epochs.get(id));
          await pilot.placeControlledShipAt(x, -360);
          await pilot.waitForCombatReady();
        }
        await game.waitForRemotePlayers(1);
        await peer.waitForRemotePlayers(1);
        // Constrain the recovery exercise, after cold loading and arranging the fixture.
        // Throttling setup can exhaust the test deadline and let teardown reset a live scene.
        await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await native.observeGame();
        native.pinDocument();
        const admittedShots: string[] = [];
        captureEvidence = async () => ({
          native: await native.read(),
          acceptedShots: [...admittedShots],
          drawing: await page.evaluate(() => {
            const report = window.georoidsPerformance?.read();
            return {
              renderer: report?.renderer,
              frameFailures: report?.counters['frameFailures'] ?? 0,
            };
          }),
          primaryWire: readWireCounters(pilotWire),
          peerWire: readWireCounters(peerWire),
        });
        retainedEvidence = () => ({
          nativeHost: native.diagnostics(),
          primaryWire: readWireCounters(pilotWire),
          peerWire: readWireCounters(peerWire),
          acceptedShots: [...admittedShots],
        });
        await stage('joined-observing-native-mobile-frames');
        async function holdTouch() {
          const steer = await centerOf(page, '#gameCanvas');
          const fire = await canvasPoint(page, 0.75, 0.5);
          await dispatchTouch(session, 'touchStart', [
            { x: steer.x + 40, y: steer.y, id: 1 },
            { ...fire, id: 2 },
          ]);
          touching = true;
          await expect.poll(async () => (await native.read()).controls.touchFire).toBe(true);
          await expect
            .poll(async () => (await native.read()).controls.pointerHeading)
            .not.toBeNull();
        }
        async function releaseTouch() {
          if (touching) {
            await dispatchTouch(session, 'touchCancel', []);
            touching = false;
          }
        }
        async function admitTouchShot() {
          await game.waitForCombatReady();
          await page.waitForFunction(() => window.gameController?.getCurrPlayer()?.ship.canShoot);
          const before = pilotWire.shots(pilotId);
          const peerBefore = peerWire.shots(pilotId);
          const inputBefore = await native.read();
          const position = peerWire.position(pilotId);
          assert(position);
          await holdTouch();
          await withScenarioCleanup(
            async () => {
              await expect
                .poll(() => [...pilotWire.shots(pilotId)].find((id) => !before.has(id)), {
                  timeout: 5000,
                })
                .toBeDefined();
              const accepted = [...pilotWire.shots(pilotId)].find((id) => !before.has(id));
              assert(accepted);
              await expect
                .poll(() => peerWire.shots(pilotId).has(accepted), { timeout: 5000 })
                .toBe(true);
              expect(peerBefore.has(accepted)).toBe(false);
              await expect
                .poll(() => {
                  const current = peerWire.position(pilotId);
                  return current ? Math.hypot(current.x - position.x, current.y - position.y) : 0;
                })
                .toBeGreaterThan(1);
              const inputAfter = await native.read();
              expect(inputAfter.trustedInputs).toBeGreaterThan(inputBefore.trustedInputs);
              expect(inputAfter.untrustedInputs).toBe(0);
              admittedShots.push(accepted);
            },
            () => releaseTouch()
          );
        }
        const beforeTouch = await readTouchControlState(page);
        await admitTouchShot();
        await game.waitForAnimationFrames(10);
        const duringTouch = await readTouchControlState(page);
        expect(duringTouch.thrusting).toBe(true);
        expect(duringTouch.lastShotTime).toBeGreaterThan(beforeTouch.lastShotTime);
        await holdTouch();
        // CDP changes the native screen orientation along with CSS viewport and DPR.
        await native.resize({ width: 844, height: 390 });
        await game.waitForAnimationFrames(2);
        expect(
          await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
            angle: screen.orientation.angle,
          }))
        ).toEqual({ width: 844, height: 390, dpr: 2, angle: 90 });
        expect((await native.read()).controls).toMatchObject({
          pointerHeading: null,
          touchFire: false,
          steerPointerHeld: false,
          canShoot: true,
        });
        expect((await readTouchControlState(page)).thrusting).toBe(true);
        await releaseTouch();
        await holdTouch();
        await stage('held-touch-before-native-hide');
        freezeConnection = await page.evaluateHandle<ConnectionManager>(
          "import('/src/network/services/ConnectionManager.ts').then(({ ConnectionManager }) => ConnectionManager.getInstance())"
        );
        freezeSocket = await freezeConnection.evaluateHandle((manager) => manager.getSocket());
        const beforeFreeze = pilotWire.read();
        assert(beforeFreeze.gameTime !== undefined);
        const frozen = await native.hideAndFreeze();
        expect(frozen.controls).toMatchObject({
          pointerHeading: null,
          touchFire: false,
          steerPointerHeld: false,
          pressedKeys: [],
          canShoot: true,
        });
        const peerBeforeFreeze = peerWire.read();
        assert(peerBeforeFreeze.gameTime !== undefined);
        await delay(400);
        const stillFrozen = await native.read();
        expect(stillFrozen.hidden).toBe(true);
        expect(stillFrozen.frameCpuCount).toBe(frozen.framesAtFreeze);
        expect(stillFrozen.rafCallbacks).toBe(frozen.callbacksAtFreeze);
        expect(peerWire.read().snapshots).toBeGreaterThan(peerBeforeFreeze.snapshots);
        expect(peerWire.read().gameTime).toBeGreaterThan(peerBeforeFreeze.gameTime);
        await stage('frozen-stable-with-live-server-peer');
        await native.resume();
        await releaseTouch();
        await page.waitForFunction(
          () => {
            const report = window.georoidsPerformance?.read();
            return (
              window.gameController?.getNetworkManager().isConnected &&
              report &&
              (report.counters['disconnects'] ?? 0) === 1 &&
              !report.pendingRecovery &&
              Object.keys(report.metrics).some((name) => name.endsWith('.recoveryMs'))
            );
          },
          undefined,
          { timeout: 10000 }
        );
        expect(await game.getLocalPlayerId()).toBe(pilotId);
        expect(pilotWire.read().connections).toBe(beforeFreeze.connections + 1);
        expect(pilotWire.read().closedConnections).toBe(beforeFreeze.closedConnections + 1);
        expect(
          await freezeConnection.evaluate(
            (manager, socket) => manager.getSocket() !== socket,
            freezeSocket
          )
        ).toBe(true);
        native.assertDocumentSurvived();
        const beforeResumedFrames = await native.read();
        await game.waitForAnimationFrames(12);
        const resumed = await native.read();
        expect(resumed.frameCpuCount).toBeGreaterThan(beforeResumedFrames.frameCpuCount);
        expect(resumed.rendererFrameCount - beforeResumedFrames.rendererFrameCount).toBe(
          resumed.frameCpuCount - beforeResumedFrames.frameCpuCount
        );
        expect(resumed.frameCpuCount).toBeGreaterThan(frozen.frameCpuCount);
        expect(resumed.rafCallbacks).toBeGreaterThan(frozen.rafCallbacks);
        expect(resumed.controls).toMatchObject({
          pointerHeading: null,
          touchFire: false,
          steerPointerHeld: false,
          pressedKeys: [],
          canShoot: true,
        });
        await expect.poll(() => pilotWire.read().gameTime).toBeGreaterThan(beforeFreeze.gameTime);
        expect((await readTouchControlState(page)).thrusting).toBe(true);
        await admitTouchShot();
        native.markAutomaticRecovery();
        await stage('native-visible-resumed-with-fresh-accepted-shot');
        const connection = await page.evaluateHandle<ConnectionManager>(
          "import('/src/network/services/ConnectionManager.ts').then(({ ConnectionManager }) => ConnectionManager.getInstance())"
        );
        const originalSocket = await connection.evaluateHandle((manager) => manager.getSocket());
        const beforeReconnect = pilotWire.read();
        await withScenarioCleanup(
          async () => {
            native.markExplicitReconnect();
            await page.evaluate((transportConnection) => {
              const socket = transportConnection.getSocket();
              if (!socket) {
                throw new Error('Missing connected transport');
              }
              socket.close(4000, 'Diagnostic reconnect verification');
            }, connection);
            await page.waitForFunction(
              () => {
                const report = window.georoidsPerformance?.read();
                return (
                  window.gameController?.getNetworkManager().isConnected &&
                  report &&
                  (report.counters['disconnects'] ?? 0) === 2 &&
                  !report.pendingRecovery &&
                  Object.keys(report.metrics).some((name) => name.endsWith('.recoveryMs'))
                );
              },
              undefined,
              { timeout: 10000 }
            );
            expect(await game.getLocalPlayerId()).toBe(pilotId);
            expect(
              await connection.evaluate(
                (manager, socket) => manager.getSocket() !== socket,
                originalSocket
              )
            ).toBe(true);
            expect(pilotWire.read().connections).toBe(beforeReconnect.connections + 1);
            expect(pilotWire.read().closedConnections).toBe(beforeReconnect.closedConnections + 1);
          },
          () => attemptScenarioCleanup([() => originalSocket.dispose(), () => connection.dispose()])
        );
        await admitTouchShot();
        expect(new Set(admittedShots).size).toBe(admittedShots.length);
        expect(pilotWire.read().errors).toEqual([]);
        expect(peerWire.read().errors).toEqual([]);
        await stage('rejoined-with-new-accepted-shot');
        // Inject into the actual render call, once; restore before doing repeated draw work.
        await page.evaluate(() => {
          const controller = window.gameController;
          const recorder = window.georoidsPerformance;
          if (!controller || !recorder) {
            throw new Error('Missing game/recorder');
          }
          recorder.read(true);
          const original = controller.renderGame;
          controller.renderGame = () => {
            controller.renderGame = original;
            const until = performance.now() + 60;
            do {
              original.call(controller);
            } while (performance.now() < until);
          };
        });
        await game.waitForAnimationFrames(4);
        const report = await page.evaluate(() => window.georoidsPerformance?.read());
        assert(report);
        expect(
          Object.entries(report.metrics)
            .filter(([name]) => name.endsWith('.renderMs'))
            .some(([, metric]) => metric.max >= 60)
        ).toBe(true);
        expect(
          Object.entries(report.metrics)
            .filter(([name]) => name.endsWith('.frameIntervalMs'))
            .some(([, metric]) => metric.max >= 50)
        ).toBe(true);
        expect(report.counters['frameFailures'] ?? 0).toBe(0);
        await page.evaluate(() => {
          window.georoidsPerformance?.read(true);
          window.addEventListener(
            'keydown',
            () => {
              const until = performance.now() + 60;
              while (performance.now() < until) {
                // Deliberate one-shot handler contention, removed by once:true.
              }
            },
            { once: true }
          );
        });
        await page.keyboard.press('ArrowLeft');
        await game.waitForAnimationFrames(3);
        const input = await page.evaluate(() => window.georoidsPerformance?.read());
        assert(input);
        expect(
          Object.entries(input.metrics)
            .filter(([name]) => name.endsWith('.inputToRenderMs'))
            .some(([, metric]) => metric.max >= 60)
        ).toBe(true);
        native.assertDocumentSurvived();
        native.assertFreezeDiagnostics(primaryDiagnostics, 2);
        assertNoBrowserDiagnostics(peerDiagnostics);
        await stage('render-and-input-contention-observed');
      },
      () =>
        attemptScenarioCleanup([
          () => stage('before-native-window-restoration'),
          () => native.restore(),
          async () => {
            if (touching) {
              await dispatchTouch(session, 'touchCancel', []);
              touching = false;
            }
          },
          async () => {
            await freezeSocket?.dispose();
          },
          async () => {
            await freezeConnection?.dispose();
          },
        ])
    );
  }
  await withScenarioCleanup(
    () =>
      withFixtureEvidence(page, 'native-constrained-mobile-recovery', runScene, {
        evidence: () => captureEvidence(),
        retainedEvidence: () => retainedEvidence(),
      }),
    () => native.close()
  );
}, 30000);
