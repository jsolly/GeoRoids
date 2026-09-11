import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test.each([false, true])(
  'a pilot records and downloads gameplay at fixed low quality, touch=%s',
  async (touch) => {
    const page = await browserManager.recreatePage({ hasTouch: touch });
    await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const diagnostics = watchBrowserDiagnostics(page);
    await page.addInitScript(() => {
      let positiveBlurWrites = 0;
      let gameStrokes = 0;
      const descriptor = Object.getOwnPropertyDescriptor(
        CanvasRenderingContext2D.prototype,
        'shadowBlur'
      );
      if (!descriptor?.set || !descriptor.get) {
        throw new Error('Canvas blur property cannot be observed');
      }
      const setter = descriptor.set;
      Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur', {
        ...descriptor,
        set(this: CanvasRenderingContext2D, value: number) {
          if (this.canvas.id === 'gameCanvas' && value > 0) {
            positiveBlurWrites++;
          }
          setter.call(this, value);
        },
      });
      const stroke = CanvasRenderingContext2D.prototype.stroke;
      CanvasRenderingContext2D.prototype.stroke = function (
        this: CanvasRenderingContext2D,
        path?: Path2D
      ) {
        if (this.canvas.id === 'gameCanvas') {
          gameStrokes++;
        }
        Reflect.apply(stroke, this, path ? [path] : []);
      };
      Reflect.set(window, 'readQualityWitness', () => ({ positiveBlurWrites, gameStrokes }));
    });
    await page.goto(`${TestConfig.GAME_URL}/?performance=collect&renderDpr=1.5&renderGlow=off`);
    const game = new GameInteractions(page);
    await game.startGame();
    await game.waitForGameReady();
    await game.waitForServerJoin();
    const panel = page.getByRole('complementary', { name: 'Performance collection' });
    await panel.getByRole('button', { name: 'Start', exact: true }).click();
    await panel.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      document
        .querySelector('aside[aria-label="Performance collection"]')
        ?.textContent?.includes('recording')
    );
    expect(await panel.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(
      await panel.getByRole('status').evaluate((element) => element === document.activeElement)
    ).toBe(true);
    if (touch) {
      const session = await page.context().newCDPSession(page);
      const stick = await centerOf(page, '#gameCanvas');
      const fire = await centerOf(page, '#touch-fire');
      try {
        await dispatchTouch(session, 'touchStart', [
          { x: stick.x + 35, y: stick.y, id: 1 },
          { ...fire, id: 2 },
        ]);
        await game.waitForAnimationFrames(40);
      } finally {
        await dispatchTouch(session, 'touchEnd', []);
        await session.detach();
      }
    } else {
      await game.holdMovementKey('ArrowUp', 600);
      await page.keyboard.press('Space');
    }
    await game.waitForAnimationFrames(60);
    const evidence = await page.evaluate(() => {
      const canvas = document.getElementById('gameCanvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Gameplay canvas missing');
      }
      const read: unknown = Reflect.get(window, 'readQualityWitness');
      if (typeof read !== 'function') {
        throw new Error('Drawing witness missing');
      }
      const witness: unknown = read();
      return {
        witness,
        width: canvas.width,
        cssWidth: canvas.getBoundingClientRect().width,
        dpr: devicePixelRatio,
      };
    });
    expect(evidence.width).toBe(Math.round(evidence.cssWidth * Math.min(evidence.dpr, 1.5)));
    expect(evidence.witness).toEqual({ positiveBlurWrites: 0, gameStrokes: expect.any(Number) });
    assert(
      evidence.witness && typeof evidence.witness === 'object' && 'gameStrokes' in evidence.witness
    );
    expect(evidence.witness.gameStrokes).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    expect(
      await panel.getByRole('status').evaluate((element) => element === document.activeElement)
    ).toBe(true);
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    const path = await download.path();
    assert(path);
    const envelope: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert(
      envelope && typeof envelope === 'object' && 'content' in envelope && 'checksum' in envelope
    );
    assert.equal(typeof envelope.content, 'string');
    assert(typeof envelope.content === 'string');
    expect(envelope.checksum).toBe(createHash('sha256').update(envelope.content).digest('hex'));
    const report: unknown = JSON.parse(envelope.content);
    assert(
      report && typeof report === 'object' && 'samples' in report && 'incompleteReason' in report
    );
    expect(report.incompleteReason).toBeNull();
    assert(Array.isArray(report.samples));
    expect(report.samples.length).toBeGreaterThan(0);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(
        `mobile-quality-${touch ? 'portrait' : 'desktop'}.png`
      ),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }
);

test('a phone collection stops visibly at its duration limit and retains an incomplete download', async () => {
  const page = browserManager.getCurrentPage();
  assert(page);
  const diagnostics = watchBrowserDiagnostics(page);
  await page.clock.install();
  await page.goto(`${TestConfig.GAME_URL}/?performance=collect`);
  const panel = page.getByRole('complementary', { name: 'Performance collection' });
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('aside[aria-label="Performance collection"]')
      ?.textContent?.includes('recording')
  );
  await page.clock.fastForward(30 * 60 * 1000 + 1000);
  expect(await panel.textContent()).toContain('Incomplete: 30 minute');
  expect(await panel.getByRole('button', { name: 'Stop', exact: true }).isDisabled()).toBe(true);
  expect(await panel.getByRole('button', { name: 'Download', exact: true }).isEnabled()).toBe(true);
  assertNoBrowserDiagnostics(diagnostics);
});

test('a phone recovers an interrupted recording after reload and exports its original conditions', async () => {
  const page = await browserManager.recreatePage({ hasTouch: true });
  const diagnostics = watchBrowserDiagnostics(page);
  await page.goto(`${TestConfig.GAME_URL}/?performance=collect`);
  const panel = page.getByRole('complementary', { name: 'Performance collection' });
  await panel.getByText('Device and conditions', { exact: true }).click();
  await panel.getByRole('textbox', { name: 'Device model and OS', exact: true }).fill('Test phone');
  await panel
    .getByRole('textbox', { name: 'Test conditions', exact: true })
    .fill('Wi-Fi, unplugged');
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('georoids-performance', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const read = (key: string) =>
              new Promise<unknown>((resolve, reject) => {
                const request = database.transaction('sessions').objectStore('sessions').get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
            const id = await read('latest');
            const header = typeof id === 'string' ? await read(id) : null;
            return (
              header &&
              typeof header === 'object' &&
              'sampleCount' in header &&
              typeof header.sampleCount === 'number' &&
              header.sampleCount > 0 &&
              'metadata' in header &&
              header.metadata &&
              typeof header.metadata === 'object' &&
              'device' in header.metadata &&
              header.metadata.device === 'Test phone'
            );
          } finally {
            database.close();
          }
        }),
      { timeout: 10000 }
    )
    .toBe(true);
  await page.reload();
  await panel.getByRole('button', { name: 'Recover last session', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('aside')?.textContent?.includes('Recording interrupted')
  );
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download', exact: true }).click();
  const path = await (await downloading).path();
  assert(path);
  const envelope: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(
    envelope &&
      typeof envelope === 'object' &&
      'content' in envelope &&
      typeof envelope.content === 'string' &&
      'checksum' in envelope
  );
  expect(envelope.checksum).toBe(createHash('sha256').update(envelope.content).digest('hex'));
  const report: unknown = JSON.parse(envelope.content);
  expect(report).toMatchObject({
    incompleteReason: 'Recording interrupted before Stop; unsaved interval unavailable',
    metadata: { device: 'Test phone', conditions: 'Wi-Fi, unplugged' },
    samples: expect.any(Array),
  });
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('georoids-performance', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('sessions', 'readwrite');
        const store = transaction.objectStore('sessions');
        const request = store.get('latest');
        request.onsuccess = () => store.put('{corrupt', `${request.result}:0`);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload();
  await panel.getByRole('button', { name: 'Recover last session', exact: true }).click();
  await expect.poll(() => panel.textContent()).toContain('corrupt sample');
  assertNoBrowserDiagnostics(diagnostics);
});
