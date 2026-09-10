import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import type { ConnectionManager } from '../../../../src/network/services/ConnectionManager';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { centerOf, dispatchTouch, readTouchControlState } from '../../utils/touch-input';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test('a constrained mobile pilot releases controls, resumes a frozen page, reconnects, and detects injected rendering work', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const session = await page.context().newCDPSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let touching = false;
  try {
    await page.goto(`${TestConfig.GAME_URL}/?performance=collect`);
    const game = new GameInteractions(page);
    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();
    const stick = await centerOf(page, '#touch-stick');
    const fire = await centerOf(page, '#touch-fire');
    await dispatchTouch(session, 'touchStart', [
      { x: stick.x + 40, y: stick.y, id: 1 },
      { ...fire, id: 2 },
    ]);
    touching = true;
    await game.waitForAnimationFrames(10);
    expect((await readTouchControlState(page)).thrusting).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    // Playwright viewport changes do not emit a phone's orientation event.
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await game.waitForAnimationFrames(2);
    expect((await readTouchControlState(page)).thrusting).toBe(false);
    await dispatchTouch(session, 'touchCancel', []);
    touching = false;
    const beforeFreeze = await page.evaluate(
      () => window.georoidsPerformance?.read().lastSnapshot?.gameTime
    );
    assert(beforeFreeze !== undefined);
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    await delay(400);
    await session.send('Page.setWebLifecycleState', { state: 'active' });
    await game.waitForAnimationFrames(3);
    await page.waitForFunction((before) => {
      const current = window.georoidsPerformance?.read().lastSnapshot?.gameTime;
      return current !== undefined && current > before;
    }, beforeFreeze);
    expect((await readTouchControlState(page)).thrusting).toBe(false);
    const connection = await page.evaluateHandle<ConnectionManager>(
      "import('/src/network/services/ConnectionManager.ts').then(({ ConnectionManager }) => ConnectionManager.getInstance())"
    );
    await page.evaluate((connection) => {
      const socket = connection.getSocket();
      if (!socket) {
        throw new Error('Missing connected transport');
      }
      socket.close(4000, 'Diagnostic reconnect verification');
    }, connection);
    await connection.dispose();
    await page.waitForFunction(
      () => {
        const report = window.georoidsPerformance?.read();
        return (
          window.gameController?.getNetworkManager().isConnected &&
          report &&
          (report.counters['disconnects'] ?? 0) > 0 &&
          !report.pendingRecovery &&
          Object.keys(report.metrics).some((name) => name.endsWith('.recoveryMs'))
        );
      },
      undefined,
      { timeout: 10000 }
    );
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
    await page.keyboard.press('ArrowUp');
    await game.waitForAnimationFrames(3);
    const input = await page.evaluate(() => window.georoidsPerformance?.read());
    assert(input);
    expect(
      Object.entries(input.metrics)
        .filter(([name]) => name.endsWith('.inputToRenderMs'))
        .some(([, metric]) => metric.max >= 60)
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await session.send('Page.setWebLifecycleState', { state: 'active' });
    if (touching) {
      await dispatchTouch(session, 'touchCancel', []);
    }
    await session.detach();
  }
}, 30000);
