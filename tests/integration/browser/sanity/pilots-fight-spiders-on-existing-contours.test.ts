import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import type { SpiderFieldState } from '../../../../shared-types';
import { installAudioProbe } from '../../utils/audio-probe';
import {
  assertNoBrowserDiagnostics,
  watchBrowserDiagnostics,
} from '../../utils/browser-diagnostics';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

function readField(page: Page): Promise<SpiderFieldState> {
  return page.evaluate(
    "import('/src/physics/terrain/spiderSession.ts').then(({getSpiderField}) => getSpiderField())"
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`a ${viewport.name} pilot finds a guarded deposit, escapes its pursuit, and shoots a guard dead`, async () => {
    const page = await browserManager.recreatePage({ hasTouch: viewport.hasTouch });
    await page.setViewportSize(viewport);
    const diagnostics = watchBrowserDiagnostics(page);
    await installAudioProbe(page, true, { music: true });
    await page.addInitScript(() => {
      const active = new Set<OscillatorNode>();
      const publish = () => {
        document.documentElement.dataset['spiderVoices'] = String(active.size);
      };
      const NativeOscillator = window.OscillatorNode;
      class ObservedOscillator extends NativeOscillator {
        override start(when = 0): void {
          super.start(when);
          active.add(this);
          if (this.frequency.value > 300) {
            document.documentElement.dataset['spiderStinger'] = 'heard';
          }
          this.addEventListener(
            'ended',
            () => {
              active.delete(this);
              publish();
            },
            { once: true }
          );
          publish();
        }
        override stop(when = 0): void {
          super.stop(when);
          if (when <= this.context.currentTime) {
            active.delete(this);
          }
          publish();
        }
      }
      class ObservedContext extends AudioContext {
        override createOscillator(): OscillatorNode {
          return new ObservedOscillator(this);
        }
      }
      AudioContext.prototype.createOscillator = ObservedContext.prototype.createOscillator;
    });
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });
    const playerId = await game.getLocalPlayerId();
    await arrangeCrewField([playerId], 'spider-nest');
    await game.placeShipAt(3000, 5000);
    await expect
      .poll(async () => (await readField(page)).spiders.length, { timeout: 5000 })
      .toBe(4);
    const predator = (await readField(page)).spiders.toSorted(
      (a, b) => a.position.x - b.position.x
    )[0];
    if (!predator) {
      throw new Error('No spider available');
    }
    await game.placeShipAt(predator.position.x - 120, predator.position.y);
    await expect
      .poll(
        async () =>
          (await readField(page)).spiders.some(
            (spider) =>
              spider.id === predator.id &&
              spider.phase === 'hunting' &&
              spider.targetId === playerId
          ),
        { timeout: 5000 }
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const chasing = (await readField(page)).spiders.find((spider) => spider.id === predator.id);
        return chasing
          ? Math.hypot(
              chasing.position.x - predator.position.x,
              chasing.position.y - predator.position.y
            )
          : 0;
      })
      .toBeGreaterThan(0);
    expect(await readField(page)).not.toHaveProperty('webs');
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-hunt-${viewport.name}.png`),
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['spiderStinger']))
      .toBe('heard');
    await expect
      .poll(() =>
        page.evaluate(
          "import('/src/audio/musicThreat.ts').then(({isMusicThreatActive}) => isMusicThreatActive())"
        )
      )
      .toBe(true);
    // Draw the guard outside its patrol before checking its return journey.
    await game.placeShipAt(4400, 5000);
    await expect
      .poll(
        async () => {
          const guard = (await readField(page)).spiders.find((spider) => spider.id === predator.id);
          return guard ? Math.hypot(guard.position.x - 5000, guard.position.y - 5000) : 0;
        },
        { timeout: 5000 }
      )
      .toBeGreaterThan(320);
    // Leave the nest's leash: the same guard must disengage and return home.
    await game.placeShipAt(3700, 5000);
    await expect
      .poll(
        async () => {
          const guard = (await readField(page)).spiders.find((spider) => spider.id === predator.id);
          return guard?.phase === 'scuttling' && guard.targetId === null;
        },
        { timeout: 5000 }
      )
      .toBe(true);
    await expect
      .poll(
        async () => {
          const guard = (await readField(page)).spiders.find((spider) => spider.id === predator.id);
          return guard ? Math.hypot(guard.position.x - 5000, guard.position.y - 5000) : Infinity;
        },
        { timeout: 10000 }
      )
      .toBeLessThanOrEqual(120);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-return-${viewport.name}.png`),
    });
    const nextPredator = (await readField(page)).spiders.find(
      (spider) => spider.id === predator.id
    );
    if (!nextPredator) {
      throw new Error('Guard disappeared instead of returning to its deposit');
    }
    const seenHealth: number[] = [];
    for (let shot = 0; shot < 6; shot++) {
      const target = (await readField(page)).spiders.find(
        (spider) => spider.id === nextPredator.id
      );
      if (!target) {
        break;
      }
      seenHealth.push(target.health);
      if (target.health < target.maxHealth) {
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(`spider-wounded-${viewport.name}.png`),
        });
      }
      // Arrange the firing lane, then use real input and authoritative damage.
      await game.placeShipAt(target.position.x - 320, target.position.y);
      await page.evaluate(() => {
        const ship = window.gameController?.getCurrPlayer()?.ship;
        if (ship) {
          ship.angle = 0;
          ship.angularVelocity = 0;
          ship.velocity = { x: 0, y: 0 };
        }
      });
      await game.waitForAnimationFrames(2);
      if (viewport.hasTouch) {
        const canvas = await page.locator('#gameCanvas').boundingBox();
        if (!canvas) {
          throw new Error('Canvas missing');
        }
        await page.touchscreen.tap(canvas.x + canvas.width * 0.75, canvas.y + canvas.height * 0.5);
      } else {
        await page.keyboard.press('Space');
      }
      await game.waitForAnimationFrames(20);
    }
    await expect
      .poll(async () =>
        (await readField(page)).spiders.some((spider) => spider.id === nextPredator.id)
      )
      .toBe(false);
    expect(seenHealth.some((value) => value < nextPredator.maxHealth)).toBe(true);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-defeated-${viewport.name}.png`),
    });
    expect(await game.getShipHealth()).toBeGreaterThan(0);
    await page.locator('#soundPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Sound preference missing');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['spiderVoices']))
      .toBe('0');
    await page.locator('#musicPref').evaluate((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Music preference missing');
      }
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['audioContextState']))
      .toBe('suspended');
    await page.goto(new URL('/wiki/#terrain', page.url()).href);
    await page.getByRole('heading', { name: 'Survive a hunt', exact: true }).waitFor();
    await page
      .getByRole('heading', { name: 'Survive a hunt', exact: true })
      .evaluate((heading) => heading.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-wiki-${viewport.name}.png`),
    });
    await page.goto(new URL('/wiki/#combat-survival', page.url()).href);
    await page.getByRole('heading', { name: 'Damage and protection', exact: true }).waitFor();
    await page
      .getByRole('heading', { name: 'Damage and protection', exact: true })
      .evaluate((heading) => heading.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({
      path: screenshotManager.getScreenshotPath(`spider-survival-${viewport.name}.png`),
    });
    assertNoBrowserDiagnostics(diagnostics);
  }, 60000);
}
