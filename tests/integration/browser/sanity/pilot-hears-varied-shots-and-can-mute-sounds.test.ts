import { readdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { installAudioProbe } from '../../utils/audio-probe';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import {
  canvasPoint,
  centerOf,
  dispatchTouch,
  readTouchControlState,
} from '../../utils/touch-input';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

async function holdInput(page: Page, mobile: boolean, input: 'thrust' | 'fire') {
  if (!mobile) {
    const key = input === 'thrust' ? 'ArrowUp' : 'Space';
    await page.keyboard.down(key);
    return () => page.keyboard.up(key);
  }
  const session = await page.context().newCDPSession(page);
  const center = await centerOf(page, '#gameCanvas');
  const point =
    input === 'thrust' ? { x: center.x + 40, y: center.y } : await canvasPoint(page, 0.75, 0.5);
  await dispatchTouch(session, 'touchStart', [{ ...point, id: 1 }]);
  return async () => {
    await dispatchTouch(session, 'touchEnd', []);
    await session.detach();
  };
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} muted pilot steers and fires without initializing audio`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.name === 'mobile' });
    await page.setViewportSize(viewport);
    await installAudioProbe(page, false);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('.m4a')) {
        requests.push(request.url());
      }
    });
    const game = new GameInteractions(page);
    await game.bootGame();
    const beforeInput = await readTouchControlState(page);
    if (viewport.name === 'mobile') {
      const session = await page.context().newCDPSession(page);
      try {
        const steer = await centerOf(page, '#gameCanvas');
        const fire = await canvasPoint(page, 0.75, 0.5);
        await dispatchTouch(session, 'touchStart', [
          { x: steer.x + 40, y: steer.y, id: 1 },
          { ...fire, id: 2 },
        ]);
        await page.waitForTimeout(1200);
        const duringInput = await readTouchControlState(page);
        expect(duringInput.thrusting).toBe(true);
        expect(duringInput.lastShotTime).toBeGreaterThan(beforeInput.lastShotTime);
      } finally {
        await dispatchTouch(session, 'touchCancel', []);
        await session.detach();
      }
    } else {
      await page.keyboard.down('ArrowUp');
      await page.keyboard.down('Space');
      await page.waitForTimeout(1200);
      const duringInput = await readTouchControlState(page);
      expect(duringInput.thrusting).toBe(true);
      expect(duringInput.lastShotTime).toBeGreaterThan(beforeInput.lastShotTime);
      await page.keyboard.up('Space');
      await page.keyboard.up('ArrowUp');
    }
    const state = await page.evaluate(() => ({
      contexts: document.documentElement.dataset['audioContexts'],
      media: document.documentElement.dataset['audioMedia'],
      events: document.documentElement.dataset['audioEvents'],
    }));
    expect(state).toEqual({ contexts: '0', media: '0', events: '[]' });
    expect(requests).toEqual([]);
  }, 60000);

  test(`${viewport.name} pilot hears varied shots and thrust, then mutes every cue`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.name === 'mobile' });
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const warnings: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        errors.push(message.text());
      }
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    await installAudioProbe(page);
    const game = new GameInteractions(page);
    await game.bootGame();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContexts']))
      .toBe('1');
    const assets = readdirSync('public/sounds').filter((name) => name.endsWith('.m4a'));
    await expect
      .poll(() => page.evaluate(() => Number(document.documentElement.dataset['decodedAudio'])))
      .toBe(assets.length);
    for (let shot = 0; shot < 4; shot++) {
      const release = await holdInput(page, viewport.name === 'mobile', 'fire');
      await page.waitForTimeout(100);
      await release();
      await page.waitForTimeout(500);
    }
    const releaseThrust = await holdInput(page, viewport.name === 'mobile', 'thrust');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const events = JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]');
          return events.some((event: { loop: boolean }) => event.loop);
        })
      )
      .toBe(true);
    await releaseThrust();
    const events: Array<{ duration: number; rate: number; loop: boolean; bufferId: number }> =
      await page.evaluate(() =>
        JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]')
      );
    expect(await page.evaluate(() => document.documentElement.dataset['audioContexts'])).toBe('1');

    // Decode every shipped sample with the real browser's codec, not a media mock.
    const decoded = await page.evaluate(async (names) => {
      const context = new OfflineAudioContext(1, 1, 48000);
      return await Promise.all(
        names.map(async (name) => {
          const response = await fetch(`/sounds/${name}`);
          if (!response.ok) {
            throw new Error(`Missing sound ${name}`);
          }
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          return {
            name,
            duration: buffer.duration,
            peak: buffer
              .getChannelData(0)
              .reduce((peak, value) => Math.max(peak, Math.abs(value)), 0),
          };
        })
      );
    }, assets);
    for (const sample of decoded) {
      expect(sample.duration).toBeGreaterThan(0);
      expect(sample.peak).toBeGreaterThan(0);
    }
    const laserDuration = decoded.find((sample) => sample.name === 'laser.m4a')?.duration;
    expect(laserDuration).toBeDefined();
    const lasers = events.filter(
      (event) => Math.abs(event.duration - (laserDuration ?? 0)) < 0.002
    );
    expect(lasers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lasers.map((event) => event.bufferId)).size).toBe(1);
    for (const laser of lasers) {
      expect(laser.rate).toBeGreaterThanOrEqual(0.8999);
      expect(laser.rate).toBeLessThanOrEqual(1.1001);
    }
    expect(new Set(lasers.map((event) => event.rate)).size).toBeGreaterThan(1);
    // Mute while native sample and synthesized sources are still active.
    const releaseMutedThrust = await holdInput(page, viewport.name === 'mobile', 'thrust');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudioLoop']))
      .toBe('true');
    await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      if (!synthesizeSplitCrack(1)) throw new Error('Live split synthesis unavailable');
    })()`);
    expect(await page.evaluate(() => document.documentElement.dataset['audioContexts'])).toBe('1');
    // The title-screen checkbox is hidden during play; exercise its real change handler.
    const immediatelyAfterMute = await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Sound preference checkbox missing');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return document.documentElement.dataset['activeAudio'];
    });
    expect(immediatelyAfterMute).toBe('0');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']))
      .toBe('0');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
      .toBe('suspended');
    await releaseMutedThrust();
    const countAfterMute = await page.evaluate(
      () => document.documentElement.dataset['audioEvents']
    );
    const releaseMutedFire = await holdInput(page, viewport.name === 'mobile', 'fire');
    await page.waitForTimeout(500);
    await releaseMutedFire();
    expect(await page.evaluate(() => document.documentElement.dataset['audioEvents'])).toBe(
      countAfterMute
    );
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`audio-${viewport.name}.png`),
    });
    await page.goto(new URL('/wiki/#hud-network', page.url()).href);
    await expect.poll(() => page.locator('body').textContent()).toContain('pitch');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`audio-wiki-${viewport.name}.png`),
    });
    // A native browser import avoids Vitest rewriting dynamic imports inside evaluate.
    const splits: Array<{ rate: number; starts: number[]; ends: number[]; peak: number }> =
      await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      const results = [];
      for (const random of [0, 0.999999]) {
        const context = new OfflineAudioContext(1, 24000, 48000);
        const starts = [], ends = [], sources = [];
        const createOscillator = context.createOscillator.bind(context);
        context.createOscillator = () => {
          const oscillator = createOscillator();
          const start = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
          const end = oscillator.frequency.exponentialRampToValueAtTime.bind(oscillator.frequency);
          oscillator.frequency.setValueAtTime = (value, at) => { starts.push(value); return start(value, at); };
          oscillator.frequency.exponentialRampToValueAtTime = (value, at) => { ends.push(value); return end(value, at); };
          return oscillator;
        };
        const createSource = context.createBufferSource.bind(context);
        context.createBufferSource = () => { const source = createSource(); sources.push(source); return source; };
        const originalRandom = Math.random;
        try {
          Math.random = () => random;
          synthesizeSplitCrack(1, context);
        } finally { Math.random = originalRandom; }
        const rendered = await context.startRendering();
        const peak = rendered.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
        results.push({ rate: sources[0].playbackRate.value, starts, ends, peak });
      }
      return results;
    })()`);
    for (const [index, split] of splits.entries()) {
      const rate = index === 0 ? 0.9 : 1.1;
      expect(split.rate).toBeCloseTo(rate);
      expect(split.starts[0]).toBeCloseTo(880 * rate, 2);
      expect(split.starts[1]).toBeCloseTo(180 * rate, 2);
      expect(split.ends[0]).toBeCloseTo(220 * rate, 2);
      expect(split.ends[1]).toBeCloseTo(70 * rate, 2);
      expect(split.peak).toBeGreaterThan(0);
    }
    const mutedSplitPeak = await page.evaluate(`(async () => {
      const { synthesizeSplitCrack } = await import('/src/audio/splitSound.ts');
      const { setSound } = await import('/src/audio/Sound.ts');
      const context = new OfflineAudioContext(1, 24000, 48000);
      setSound(true);
      synthesizeSplitCrack(1, context);
      setSound(false);
      const rendered = await context.startRendering();
      return rendered.getChannelData(0).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    })()`);
    expect(mutedSplitPeak).toBe(0);
    writeFileSync(
      screenshotManager.getScreenshotPath(`audio-${viewport.name}-receipt.json`),
      JSON.stringify({ events, decoded, splits, mutedSplitPeak, errors, warnings }, null, 2)
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  }, 60000);
}
