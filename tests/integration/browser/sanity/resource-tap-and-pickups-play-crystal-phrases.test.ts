import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { installAudioProbe, readSamplePlaybackRates } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField, placePlayer } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} tap ejections and collected canisters perform complementary phrases`, async () => {
    const mobile = viewport.name === 'mobile';
    const page = await browserManager.recreatePage({ hasTouch: mobile });
    await page.setViewportSize(viewport);
    await installAudioProbe(page);
    const diagnostics = watchBrowserDiagnostics(page);
    const ejected: Array<{ lootId: string; position: { x: number; y: number } }> = [];
    const collected = new Set<string>();
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.endsWith('/ws')) {
        return;
      }
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'tapEjected') {
          ejected.push(message.data);
        }
        if (message.type === 'lootCollected' && message.data.kind === 'tap') {
          collected.add(message.data.lootId);
        }
      });
    });
    const game = new GameInteractions(page);
    await game.bootGame({
      kitId: 'hauler',
      haulerUtility: 'resource_tap',
      waitForCombatReady: false,
    });
    const id = await game.getLocalPlayerId();
    await arrangeCrewField([id], 'tow');
    await game.waitForAnimationFrames(10);
    // Use native decoding to identify the actual sample buffers in the probe.
    const durations = await page.evaluate(async () => {
      const context = new OfflineAudioContext(1, 1, 48000);
      const duration = async (name: string) => {
        const response = await fetch(`/sounds/${name}.m4a`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        return buffer.duration;
      };
      return { ejection: await duration('tap-eject'), pickup: await duration('loot-pickup') };
    });
    await expect
      .poll(() => page.evaluate(() => Number(document.documentElement.dataset['decodedAudio'])))
      .toBeGreaterThanOrEqual(16);
    if (mobile) {
      await page.locator('#touch-ability').tap();
    } else {
      await page.keyboard.press('e');
    }
    await expect.poll(() => ejected.length, { timeout: 5000 }).toBe(4);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`crystal-tap-${viewport.name}.png`),
    });
    // Place beside real, server-created canisters. Collection still runs through
    // authoritative overlap, transport dispatch and the ordinary audio backend.
    for (const drop of ejected.slice(0, 3)) {
      if (collected.has(drop.lootId)) {
        continue;
      }
      const position: { x: number; y: number } | null = await page.evaluate(`(async () => {
        const { LootField } = await import('/src/entities/loot/LootField.ts');
        return LootField.getInstance().getAll().find(drop => drop.id === ${JSON.stringify(drop.lootId)})?.position ?? null;
      })()`);
      expect(position).not.toBeNull();
      if (!position) {
        throw new Error('Uncollected canister missing');
      }
      await placePlayer(id, position);
      await expect
        .poll(() => collected.has(drop.lootId), { timeout: 2000, interval: 20 })
        .toBe(true);
    }
    await expect.poll(() => collected.size).toBeGreaterThanOrEqual(3);
    const events: Array<{ duration: number; rate: number }> = await page.evaluate(() =>
      JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]')
    );
    const ejectionRates = events
      .filter((event) => Math.abs(event.duration - durations.ejection) < 0.00001)
      .map((event) => event.rate);
    const pickupRates = events
      .filter((event) => Math.abs(event.duration - durations.pickup) < 0.00001)
      .map((event) => event.rate);
    expect(ejectionRates).toHaveLength(4);
    for (const [index, semitones] of [0, 7, 4, 12].entries()) {
      expect(ejectionRates[index]).toBeCloseTo(2 ** (semitones / 12));
    }
    expect(pickupRates.length).toBeGreaterThanOrEqual(3);
    for (const [index, semitones] of [4, 7, 12].entries()) {
      expect(pickupRates[index]).toBeCloseTo(2 ** (semitones / 12));
    }
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`crystal-pickups-${viewport.name}.png`),
    });
    await page.locator('#universe-map-toggle').click();
    await page.locator('#universe-map-close').click();
    expect(await readSamplePlaybackRates(page, 'interface')).toEqual([1, 1]);
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Missing sound checkbox');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']))
      .toBe('0');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
      .toBe('suspended');
    await page.goto(new URL('/wiki/#loot-growth', page.url()).href);
    await expect
      .poll(() => page.locator('body').textContent())
      .toContain('quick pickups play successive notes of a short melody');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`crystal-wiki-${viewport.name}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
    writeFileSync(
      screenshotManager.getScreenshotPath(`crystal-${viewport.name}-receipt.json`),
      JSON.stringify(
        { ejected, collected: [...collected], ejectionRates, pickupRates, diagnostics },
        null,
        2
      )
    );
  }, 60000);
}
