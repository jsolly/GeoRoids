// @vitest-environment node
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import type { ConnectionManager } from '../../../../src/network/services/ConnectionManager';
import {
  observeGpuGameDrawing,
  watchGpuPilotSnapshots,
} from '../../../support/gpu-gameplay-observation';
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
import { canvasPoint, centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

for (const device of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'touch', width: 390, height: 844, hasTouch: true },
]) {
  test(
    `two ${device.name} GPU pilots keep flying and firing through loss, resize, resume and reconnect`,
    async () => {
      await browserManager.closeAllPages();
      const native = await createNativeLifecycleBrowser(device);
      const { page, session } = native;
      let peerNative: Awaited<ReturnType<typeof createNativeLifecycleBrowser>> | undefined;
      let captureEvidence: () => Promise<unknown> = () => Promise.resolve(null);
      let retainedEvidence: () => unknown = () => ({ nativeHost: native.diagnostics() });
      async function runScene(stage: (name: string) => Promise<void>): Promise<void> {
        const crewNative = await createNativeLifecycleBrowser(device);
        peerNative = crewNative;
        const peerPage = crewNative.page;
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
          await pilotPage.goto(`${TestConfig.GAME_URL}/?renderer=webgl2&performance=collect`);
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
        await join(game, page, 'GPU flight');
        const pilotId = await game.getLocalPlayerId();
        await arrangeCrewField([pilotId], 'empty');
        await join(peer, peerPage, 'GPU crew');
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
        const drawing = await observeGpuGameDrawing(page);
        const peerDrawing = await observeGpuGameDrawing(peerPage);
        await native.observeGame();
        native.pinDocument();
        await crewNative.observeGame();
        crewNative.pinDocument();
        const admittedShots: string[] = [];
        let drawingObserved = true;
        let primaryDrawing: unknown;
        let crewDrawing: unknown;
        captureEvidence = async () => {
          if (drawingObserved) {
            primaryDrawing = await drawing.evaluate((witness) => witness.read());
            crewDrawing = await peerDrawing.evaluate((witness) => witness.read());
          }
          return {
            native: await native.read(),
            crewNative: await crewNative.read(),
            nativeHosts: { primary: native.diagnostics(), peer: crewNative.diagnostics() },
            acceptedShots: [...admittedShots],
            primaryDrawing,
            crewDrawing,
            drawingObservation: drawingObserved ? 'live' : 'retained-before-cleanup',
            primaryWire: readWireCounters(pilotWire),
            peerWire: readWireCounters(peerWire),
          };
        };
        retainedEvidence = () => ({
          nativeHost: native.diagnostics(),
          crewNativeHost: crewNative.diagnostics(),
          primaryDrawing,
          crewDrawing,
          primaryWire: readWireCounters(pilotWire),
          peerWire: readWireCounters(peerWire),
          acceptedShots: [...admittedShots],
        });
        await stage('joined-observing-native-frames');
        const connection = await page.evaluateHandle<ConnectionManager>(
          "import('/src/network/services/ConnectionManager.ts').then(module => module.ConnectionManager.getInstance())"
        );
        const originalSocket = await connection.evaluateHandle((manager) => manager.getSocket());
        let frozen = false;
        let touching = false;
        let firing = false;
        let resumedSocket: typeof originalSocket | undefined;
        await withScenarioCleanup(
          async () => {
            async function admitNewShot() {
              await game.waitForCombatReady();
              await page.waitForFunction(
                () => window.gameController?.getCurrPlayer()?.ship.canShoot
              );
              const inputBefore = await native.read();
              const pilotShots = pilotWire.shots(pilotId);
              const peerShots = peerWire.shots(pilotId);
              if (device.hasTouch) {
                const steer = await centerOf(page, '#gameCanvas');
                const fire = await canvasPoint(page, 0.75, 0.5);
                await dispatchTouch(session, 'touchStart', [
                  { x: steer.x + 35, y: steer.y, id: 1 },
                  { ...fire, id: 2 },
                ]);
                touching = true;
              } else {
                await page.keyboard.down('ArrowRight');
                await page.keyboard.down('Space');
                firing = true;
              }
              return withScenarioCleanup(
                async () => {
                  await expect
                    .poll(() => [...pilotWire.shots(pilotId)].find((id) => !pilotShots.has(id)), {
                      timeout: 5000,
                    })
                    .toBeDefined();
                  const admitted = [...pilotWire.shots(pilotId)].find((id) => !pilotShots.has(id));
                  assert(admitted);
                  await expect
                    .poll(() => peerWire.shots(pilotId).has(admitted), { timeout: 5000 })
                    .toBe(true);
                  expect(peerShots.has(admitted)).toBe(false);
                  const inputAfter = await native.read();
                  expect(inputAfter.trustedInputs).toBeGreaterThan(inputBefore.trustedInputs);
                  expect(inputAfter.untrustedInputs).toBe(0);
                  return admitted;
                },
                () =>
                  attemptScenarioCleanup([
                    async () => {
                      if (touching) {
                        await dispatchTouch(session, 'touchCancel', []);
                        touching = false;
                      }
                    },
                    async () => {
                      if (firing) {
                        await page.keyboard.up('Space');
                      }
                    },
                    async () => {
                      if (firing) {
                        await page.keyboard.up('ArrowRight');
                        firing = false;
                      }
                    },
                  ])
              );
            }
            async function requireLiveProgress(
              expectedSocket = originalSocket,
              expectedConnections = 1,
              expectedClosed = 0
            ) {
              const before = await drawing.evaluate((witness) => witness.read());
              const peerBefore = peerWire.read();
              const pilotBefore = pilotWire.read();
              const position = peerWire.position(pilotId);
              assert(
                position && peerBefore.gameTime !== undefined && pilotBefore.gameTime !== undefined
              );
              await game.waitForAnimationFrames(12);
              await expect
                .poll(() => peerWire.read().gameTime)
                .toBeGreaterThan(peerBefore.gameTime);
              await expect
                .poll(() => pilotWire.read().gameTime)
                .toBeGreaterThan(pilotBefore.gameTime);
              await expect
                .poll(() => {
                  const now = peerWire.position(pilotId);
                  return now ? Math.hypot(now.x - position.x, now.y - position.y) : 0;
                })
                .toBeGreaterThan(1);
              const after = await drawing.evaluate((witness) => witness.read());
              expect(after.renders).toBeGreaterThan(before.renders);
              expect(after.frameCpuCount - before.frameCpuCount).toBe(
                after.renders - before.renders
              );
              expect(after.duplicateFrameTimestamps).toBe(0);
              expect(after.rafObservedRenders).toBeGreaterThan(before.rafObservedRenders);
              expect(after.sameOwner).toBe(true);
              expect(after.gpuCanvases).toBe(1);
              expect(after.bankLabels).toBeGreaterThan(before.bankLabels);
              expect(after.counters?.['frameFailures'] ?? 0).toBe(0);
              expect(after.backing.width).toBe(after.backing.gpuWidth);
              expect(after.backing.height).toBe(after.backing.gpuHeight);
              expect(
                await connection.evaluate(
                  (manager, socket) => manager.getSocket() === socket,
                  expectedSocket
                )
              ).toBe(true);
              expect(pilotWire.read().connections).toBe(expectedConnections);
              expect(pilotWire.read().closedConnections).toBe(expectedClosed);
            }
            await expect
              .poll(() => drawing.evaluate((witness) => witness.read().backend))
              .toBe('webgl2');
            await expect
              .poll(() => peerDrawing.evaluate((witness) => witness.read().backend))
              .toBe('webgl2');
            const crewBefore = await peerDrawing.evaluate((witness) => witness.read());
            const nativeCrewBefore = await crewNative.read();
            expect(nativeCrewBefore.viewport).toEqual({
              width: device.width,
              height: device.height,
              dpr: device.hasTouch ? 2 : 1,
            });
            expect(nativeCrewBefore.rendererBackend).toBe('webgl2');
            const nativePilotBefore = await native.read();
            expect(nativePilotBefore.viewport).toEqual(nativeCrewBefore.viewport);
            expect(nativePilotBefore.rendererBackend).toBe('webgl2');
            expect(crewNative.diagnostics().pid).not.toBe(native.diagnostics().pid);
            expect(crewNative.diagnostics().profile).not.toBe(native.diagnostics().profile);
            expect(crewNative.diagnostics().launch).toMatchObject({
              executablePath: native.diagnostics().launch.executablePath,
              initialDevice: device,
            });
            const comparableArgs = (args: readonly string[]) =>
              args.filter((argument) => !argument.startsWith('--user-data-dir='));
            expect(comparableArgs(crewNative.diagnostics().launch.args)).toEqual(
              comparableArgs(native.diagnostics().launch.args)
            );
            await requireLiveProgress();
            admittedShots.push(await admitNewShot());
            for (let cycle = 1; cycle <= 2; cycle++) {
              const beforeLoss = await drawing.evaluate((witness) => witness.read());
              await drawing.evaluate((witness) => witness.lose());
              await expect
                .poll(() => drawing.evaluate((witness) => witness.read().stats?.state))
                .toBe('context-lost');
              await requireLiveProgress();
              const fallback = await drawing.evaluate((witness) => witness.read());
              expect(fallback.backend).toBe('canvas');
              expect(fallback.opaqueContext).toBe(true);
              expect(fallback.opaqueBackgrounds).toBeGreaterThan(beforeLoss.opaqueBackgrounds);
              expect(fallback.contourPaths).toBeGreaterThan(beforeLoss.contourPaths);
              expect(fallback.bankLabels).toBeGreaterThan(beforeLoss.bankLabels);
              expect(fallback.renderer?.frames.canvas).toBeGreaterThan(
                beforeLoss.renderer?.frames.canvas ?? 0
              );
              admittedShots.push(await admitNewShot());
              if (cycle === 1) {
                await native.resize(
                  device.hasTouch ? { width: 844, height: 390 } : { width: 1100, height: 720 }
                );
                await game.waitForAnimationFrames(3);
                const resized = await drawing.evaluate((witness) => witness.read());
                expect(resized.css).toEqual(
                  device.hasTouch ? { width: 844, height: 390 } : { width: 1100, height: 720 }
                );
                expect(resized.backing.width).toBe(resized.backing.gpuWidth);
                expect(resized.backing.height).toBe(resized.backing.gpuHeight);
              }
              await page.screenshot({
                path: screenshotManager.getScreenshotPath(
                  `gpu-${device.name}-fallback-${cycle}.png`
                ),
              });
              await drawing.evaluate((witness) => witness.restoreContext());
              await expect
                .poll(() => drawing.evaluate((witness) => witness.read().backend))
                .toBe('webgl2');
              await requireLiveProgress();
              const restored = await drawing.evaluate((witness) => witness.read());
              expect(restored.stats?.contextLosses).toBe(cycle);
              expect(restored.stats?.contextRestorations).toBe(cycle);
              expect(restored.stats?.drawCalls).toBeGreaterThan(0);
              if (restored.stats?.contourMode === 'canvas-path') {
                expect(['hairline', 'rotated-path-coverage']).toContain(
                  restored.stats.contourReason
                );
                expect(restored.stats.submittedSegments).toBe(0);
                expect(restored.stats.nativeContourSegments).toBeGreaterThan(0);
              } else {
                expect(restored.stats?.contourMode).toBe('gpu-capsules');
                expect(restored.stats?.contourReason).toBe('none');
                expect(restored.stats?.submittedSegments).toBeGreaterThan(0);
                expect(restored.stats?.nativeContourSegments).toBe(0);
              }
              expect(restored.opaqueContext).toBe(true);
              expect(restored.stats?.rearBlits).toBe(1);
              expect(restored.renderer?.frames.webgl2).toBeGreaterThan(
                fallback.renderer?.frames.webgl2 ?? 0
              );
              await page.screenshot({
                path: screenshotManager.getScreenshotPath(
                  `gpu-${device.name}-restored-${cycle}.png`
                ),
              });
            }
            // Hide while actual controls are held; cruise continues independently of input.
            if (device.hasTouch) {
              const steer = await centerOf(page, '#gameCanvas');
              const fire = await canvasPoint(page, 0.75, 0.5);
              await dispatchTouch(session, 'touchStart', [
                { x: steer.x + 35, y: steer.y, id: 1 },
                { ...fire, id: 2 },
              ]);
              touching = true;
              await expect.poll(async () => (await native.read()).controls.touchFire).toBe(true);
              await expect
                .poll(async () => (await native.read()).controls.pointerHeading)
                .not.toBeNull();
            } else {
              await page.keyboard.down('ArrowRight');
              await page.keyboard.down('Space');
              firing = true;
              expect((await native.read()).controls.pressedKeys).toContain('Space');
              expect((await native.read()).controls.pressedKeys).toContain('ArrowRight');
            }
            await stage('held-input-before-native-hide');
            const wireBeforeFreeze = pilotWire.read();
            const beforeFreeze = await drawing.evaluate((witness) => witness.read());
            frozen = true;
            const nativeFrozen = await native.hideAndFreeze();
            const drawingFrozen = await drawing.evaluate((witness) => witness.read());
            expect(nativeFrozen.controls).toMatchObject({
              pointerHeading: null,
              touchFire: false,
              steerPointerHeld: false,
              pressedKeys: [],
              canShoot: true,
            });
            // Time under freeze is the stimulus. The independent live pilot proves
            // the server progresses while the primary's executed callbacks stay stopped.
            const serverBeforeFreeze = peerWire.read();
            const crewBeforeFreeze = await crewNative.read();
            const crewDrawingBeforeFreeze = await peerDrawing.evaluate((witness) => witness.read());
            assert(serverBeforeFreeze.gameTime !== undefined);
            await delay(400);
            const whileFrozen = await native.read();
            expect(whileFrozen.frameCpuCount).toBe(nativeFrozen.framesAtFreeze);
            expect(whileFrozen.rafCallbacks).toBe(nativeFrozen.callbacksAtFreeze);
            expect((await drawing.evaluate((witness) => witness.read())).renders).toBe(
              drawingFrozen.renders
            );
            expect(peerWire.read().snapshots).toBeGreaterThan(serverBeforeFreeze.snapshots);
            expect(peerWire.read().gameTime).toBeGreaterThan(serverBeforeFreeze.gameTime);
            const crewWhileFrozen = await crewNative.read();
            expect(crewWhileFrozen.hidden).toBe(false);
            expect(crewWhileFrozen.freezeEvents).toBe(0);
            expect(crewWhileFrozen.rafCallbacks).toBeGreaterThan(crewBeforeFreeze.rafCallbacks);
            expect(crewWhileFrozen.frameCpuCount).toBeGreaterThan(crewBeforeFreeze.frameCpuCount);
            expect(crewWhileFrozen.rendererFrameCount - crewBeforeFreeze.rendererFrameCount).toBe(
              crewWhileFrozen.frameCpuCount - crewBeforeFreeze.frameCpuCount
            );
            const crewDrawingWhileFrozen = await peerDrawing.evaluate((witness) => witness.read());
            expect(crewDrawingWhileFrozen.renders).toBeGreaterThan(crewDrawingBeforeFreeze.renders);
            expect(
              crewDrawingWhileFrozen.frameCpuCount - crewDrawingBeforeFreeze.frameCpuCount
            ).toBe(crewDrawingWhileFrozen.renders - crewDrawingBeforeFreeze.renders);
            await stage('frozen-stable-with-live-server-peer');
            await native.resume();
            frozen = false;
            // Clear physical contacts after the native hide already released game input.
            if (touching) {
              await dispatchTouch(session, 'touchCancel', []);
              touching = false;
            }
            if (firing) {
              await page.keyboard.up('Space');
              await page.keyboard.up('ArrowRight');
              firing = false;
            }
            await page.waitForFunction(
              () => {
                const report = window.georoidsPerformance?.read();
                return (
                  window.gameController?.getNetworkManager().isConnected &&
                  report &&
                  (report.counters['disconnects'] ?? 0) === 1 &&
                  !report.pendingRecovery &&
                  Object.keys(report.metrics).some((key) => key.endsWith('.recoveryMs'))
                );
              },
              undefined,
              { timeout: 10000 }
            );
            expect(await game.getLocalPlayerId()).toBe(pilotId);
            expect(pilotWire.read().connections).toBe(wireBeforeFreeze.connections + 1);
            expect(pilotWire.read().closedConnections).toBe(wireBeforeFreeze.closedConnections + 1);
            resumedSocket = await connection.evaluateHandle((manager) => manager.getSocket());
            expect(
              await connection.evaluate(
                (manager, socket) => manager.getSocket() !== socket,
                originalSocket
              )
            ).toBe(true);
            native.assertDocumentSurvived();
            await requireLiveProgress(resumedSocket, 2, 1);
            const nativeResumed = await native.read();
            expect(nativeResumed.hidden).toBe(false);
            expect(nativeResumed.frameCpuCount).toBeGreaterThan(nativeFrozen.frameCpuCount);
            expect(nativeResumed.rafCallbacks).toBeGreaterThan(nativeFrozen.rafCallbacks);
            expect(nativeResumed.controls).toMatchObject({
              pointerHeading: null,
              touchFire: false,
              steerPointerHeld: false,
              pressedKeys: [],
              canShoot: true,
            });
            const resumed = await drawing.evaluate((witness) => witness.read());
            expect(resumed.freezeEvents).toBe(beforeFreeze.freezeEvents + 1);
            expect(resumed.resumeEvents).toBe(beforeFreeze.resumeEvents + 1);
            expect(resumed.rendersAtResume).toBe(resumed.rendersAtFreeze);
            expect(resumed.hiddenEvents).toBeGreaterThan(beforeFreeze.hiddenEvents);
            expect(resumed.backend).toBe('webgl2');
            await stage('native-visible-resumed-with-released-controls');
            admittedShots.push(await admitNewShot());
            native.markAutomaticRecovery();
            const beforeReconnect = pilotWire.read();
            const drawingBeforeReconnect = await drawing.evaluate((witness) => witness.read());
            native.markExplicitReconnect();
            await connection.evaluate((manager) => {
              const socket = manager.getSocket();
              if (!socket) {
                throw new Error('Missing live private transport');
              }
              socket.close(4000, 'GPU gameplay recovery scenario');
            });
            await page.waitForFunction(
              () => {
                const report = window.georoidsPerformance?.read();
                return (
                  window.gameController?.getNetworkManager().isConnected &&
                  report &&
                  (report.counters['disconnects'] ?? 0) === 2 &&
                  !report.pendingRecovery &&
                  Object.keys(report.metrics).some((key) => key.endsWith('.recoveryMs'))
                );
              },
              undefined,
              { timeout: 10000 }
            );
            expect(await game.getLocalPlayerId()).toBe(pilotId);
            expect(
              await connection.evaluate(
                (manager, socket) => manager.getSocket() !== socket,
                resumedSocket
              )
            ).toBe(true);
            expect(pilotWire.read().connections).toBe(beforeReconnect.connections + 1);
            expect(pilotWire.read().closedConnections).toBe(beforeReconnect.closedConnections + 1);
            await expect
              .poll(() => drawing.evaluate((witness) => witness.read().backend))
              .toBe('webgl2');
            await game.waitForAnimationFrames(12);
            admittedShots.push(await admitNewShot());
            expect(new Set(admittedShots).size).toBe(admittedShots.length);
            const final = await drawing.evaluate((witness) => witness.read());
            const crew = await peerDrawing.evaluate((witness) => witness.read());
            expect(final.sameOwner && crew.sameOwner).toBe(true);
            expect(final.gpuCanvases).toBe(1);
            expect(final.backend).toBe('webgl2');
            expect(final.renders).toBeGreaterThan(drawingBeforeReconnect.renders);
            expect(final.frameCpuCount - drawingBeforeReconnect.frameCpuCount).toBe(
              final.renders - drawingBeforeReconnect.renders
            );
            expect(final.bankLabels).toBeGreaterThan(drawingBeforeReconnect.bankLabels);
            expect(final.duplicateFrameTimestamps).toBe(0);
            expect(final.rafObservedRenders).toBeGreaterThan(
              drawingBeforeReconnect.rafObservedRenders
            );
            expect(pilotWire.read().connections).toBe(beforeReconnect.connections + 1);
            expect(pilotWire.read().closedConnections).toBe(beforeReconnect.closedConnections + 1);
            expect(crew.backend).toBe('webgl2');
            expect(crew.renders).toBeGreaterThan(crewBefore.renders);
            expect(crew.frameCpuCount - crewBefore.frameCpuCount).toBe(
              crew.renders - crewBefore.renders
            );
            expect(crew.bankLabels).toBeGreaterThan(crewBefore.bankLabels);
            expect(crew.duplicateFrameTimestamps).toBe(0);
            expect(crew.rafObservedRenders).toBeGreaterThan(crewBefore.rafObservedRenders);
            expect(final.counters?.['frameFailures'] ?? 0).toBe(0);
            expect(crew.counters?.['frameFailures'] ?? 0).toBe(0);
            expect(peerWire.read().connections).toBe(1);
            expect(peerWire.read().closedConnections).toBe(0);
            const nativeCrewFinal = await crewNative.read();
            expect(nativeCrewFinal.hidden).toBe(false);
            expect(nativeCrewFinal.freezeEvents).toBe(0);
            expect(nativeCrewFinal.resumeEvents).toBe(0);
            expect(nativeCrewFinal.rafCallbacks).toBeGreaterThan(nativeCrewBefore.rafCallbacks);
            expect(nativeCrewFinal.frameCpuCount).toBeGreaterThan(nativeCrewBefore.frameCpuCount);
            expect(nativeCrewFinal.rendererFrameCount - nativeCrewBefore.rendererFrameCount).toBe(
              nativeCrewFinal.frameCpuCount - nativeCrewBefore.frameCpuCount
            );
            crewNative.assertDocumentSurvived();
            expect(pilotWire.read().errors).toEqual([]);
            expect(peerWire.read().errors).toEqual([]);
            native.assertDocumentSurvived();
            native.assertFreezeDiagnostics(primaryDiagnostics, 2);
            assertNoBrowserDiagnostics(peerDiagnostics);
            await stage('rejoined-with-new-accepted-shot-and-continuous-rendering');
          },
          async () => {
            await attemptScenarioCleanup([
              () => stage('before-observation-cleanup'),
              async () => {
                drawingObserved = false;
                if (frozen) {
                  await native.restore();
                  frozen = false;
                }
              },
              async () => {
                if (touching) {
                  await dispatchTouch(session, 'touchCancel', []);
                  touching = false;
                }
              },
              async () => {
                if (firing) {
                  await page.keyboard.up('Space');
                }
              },
              async () => {
                if (firing) {
                  await page.keyboard.up('ArrowRight');
                  firing = false;
                }
              },
              () => drawing.evaluate((witness) => witness.cleanup()),
              () => peerDrawing.evaluate((witness) => witness.cleanup()),
              () => drawing.dispose(),
              () => peerDrawing.dispose(),
              async () => {
                await resumedSocket?.dispose();
              },
              () => originalSocket.dispose(),
              () => connection.dispose(),
            ]);
          }
        );
      }
      await withScenarioCleanup(
        () =>
          withFixtureEvidence(page, `native-gpu-recovery-${device.name}`, runScene, {
            evidence: () => captureEvidence(),
            retainedEvidence: () => retainedEvidence(),
          }),
        () =>
          attemptScenarioCleanup([
            async () => {
              await peerNative?.close();
            },
            () => native.close(),
          ])
      );
    },
    TestConfig.DEFAULT_TIMEOUT
  );
}
