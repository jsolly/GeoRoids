// @vitest-environment node
import { expect, test } from 'vitest';
import {
  installAudioProbe,
  readNativeAudioSnapshot,
  readSampleDuration,
  readSamplePlaybackRates,
} from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField, placePlayer } from '../../utils/test-server-control';
import { writeScenarioReceipt } from '../../utils/write-scenario-receipt';

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
    const failures: unknown[] = [];
    let stage = 'gameplay';
    const snapshots: Array<{
      stage: string;
      audio: Awaited<ReturnType<typeof readNativeAudioSnapshot>> | null;
      game: unknown;
    }> = [];
    const capture = async (label: string) => {
      const [audio, gameState] = await Promise.allSettled([
        readNativeAudioSnapshot(page),
        page.evaluate(() => {
          const player = window.gameController?.getCurrPlayer();
          return {
            health: player?.ship?.health,
            cargo: player?.cargo,
            mass: player?.ship?.mass,
            preferences: {
              sound: localStorage.getItem('soundOn'),
              music: localStorage.getItem('musicOn'),
            },
            events: JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]'),
          };
        }),
      ]);
      snapshots.push({
        stage: label,
        audio: audio.status === 'fulfilled' ? audio.value : null,
        game: gameState.status === 'fulfilled' ? gameState.value : null,
      });
      const captureFailures = [audio, gameState].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (captureFailures.length) {
        throw new AggregateError(captureFailures, `Resource audio capture failed at ${label}`);
      }
    };
    try {
      const game = new GameInteractions(page);
      await game.bootGame({
        kitId: 'hauler',
        waitForCombatReady: false,
      });
      await game.collectEquipment(['resource_tap'], 'resource_tap');
      const id = await game.getLocalPlayerId();
      await arrangeCrewField([id], 'tow');
      await game.waitForAnimationFrames(10);
      // Use native decoding to identify the actual sample buffers in the probe.
      const durations = {
        ejection: await readSampleDuration(page, 'tap-eject'),
        pickup: await readSampleDuration(page, 'loot-pickup'),
      };
      await expect
        .poll(() => page.evaluate(() => Number(document.documentElement.dataset['decodedAudio'])))
        .toBeGreaterThanOrEqual(16);
      const readHull = () =>
        page.evaluate(() => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          if (!ship) {
            throw new Error('Missing canister collector');
          }
          return { mass: ship.mass, maxHealth: ship.maxHealth };
        });
      const hullBeforeCollection = await readHull();
      // Equipment setup plays a pickup note. Start a fresh phrase and observe
      // only the extraction and real canister pickups triggered below.
      const audioBaseline: number = await page.evaluate(`(async () => {
        const { resetResourceMusic } = await import('/src/audio/resourceMusic.ts');
        resetResourceMusic();
        return JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]').length;
      })()`);
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
        let position: { x: number; y: number } | null = null;
        // A placement can collect neighboring drops too. Their client removal and
        // the observer's collection event can arrive on opposite sides of evaluate.
        await expect
          .poll(
            async () => {
              if (collected.has(drop.lootId)) {
                return true;
              }
              position = await page.evaluate(`(async () => {
            const { LootField } = await import('/src/entities/loot/LootField.ts');
            return LootField.getInstance().getAll().find(drop => drop.id === ${JSON.stringify(drop.lootId)})?.position ?? null;
          })()`);
              return collected.has(drop.lootId) || position !== null;
            },
            { timeout: 2000, interval: 20 }
          )
          .toBe(true);
        if (collected.has(drop.lootId)) {
          continue;
        }
        if (!position) {
          throw new Error('Uncollected canister missing');
        }
        await placePlayer(id, position);
        await expect
          .poll(() => collected.has(drop.lootId), { timeout: 2000, interval: 20 })
          .toBe(true);
      }
      await expect.poll(() => collected.size).toBeGreaterThanOrEqual(3);
      await game.waitForAnimationFrames(12);
      const hullAfterCollection = await readHull();
      expect(hullAfterCollection).toEqual(hullBeforeCollection);
      const events: Array<{ duration: number; rate: number }> = await page.evaluate(
        (baseline) =>
          JSON.parse(document.documentElement.dataset['audioEvents'] ?? '[]').slice(baseline),
        audioBaseline
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
      const interfaceBeforeMap = (await readSamplePlaybackRates(page, 'interface')).length;
      await page.locator('#universe-map-toggle').click();
      await page.locator('#universe-map-close').click();
      expect((await readSamplePlaybackRates(page, 'interface')).slice(interfaceBeforeMap)).toEqual([
        1, 1,
      ]);
      stage = 'mute';
      await capture('beforeMute');
      await page.locator('#soundPref').evaluate((input) => {
        if (!(input instanceof HTMLInputElement)) {
          throw new Error('Missing sound checkbox');
        }
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await capture('afterMute');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset['activeAudio']))
        .toBe('0');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
        .toBe('suspended');
      await capture('afterSuspend');
      stage = 'wiki';
      await page.goto(new URL('/wiki/#loot-growth', page.url()).href);
      await expect.poll(() => page.locator('body').textContent()).toContain('Loot and salvage');
      await expect
        .poll(() => page.locator('body').textContent())
        .toContain('quick pickups play successive notes of a short melody');
      await page.screenshot({
        path: screenshotManager.getScreenshotPath(`crystal-wiki-${viewport.name}.png`),
      });
      assertNoBrowserDiagnostics(diagnostics);
    } catch (error) {
      failures.push(error);
      try {
        await capture('failure');
      } catch (captureError) {
        failures.push(captureError);
      }
    }
    writeScenarioReceipt({
      path: screenshotManager.getScreenshotPath(`crystal-${viewport.name}-receipt.json`),
      receipt: () => ({
        status: failures.length ? 'failed' : 'passed',
        stage,
        ejected,
        collected: [...collected],
        snapshots,
        diagnostics,
        errors: failures.map(String),
      }),
      failures,
      message: `Resource tap audio scenario failed during ${stage}`,
    });
  }, 60000);
}
