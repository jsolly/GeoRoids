import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type Browser, chromium, type Page } from 'playwright';

// The verification entry point accepts no target URL and uses the owned local origin.
const origin = 'http://127.0.0.1:5173';
const artifactSetting = process.env['BROWSER_SMOKE_ARTIFACTS'];
const candidateSha = process.env['REQUESTED_SHA'];
assert(process.env['GITHUB_ACTIONS'] === 'true', 'Run through the manual Browser smoke workflow');
assert(
  artifactSetting && isAbsolute(artifactSetting),
  'An absolute artifact directory is required'
);
const artifacts: string = artifactSetting;
assert(candidateSha && /^[0-9a-f]{40}$/u.test(candidateSha), 'An exact candidate SHA is required');
await mkdir(artifacts, { recursive: true });

const errors: string[] = [];
const warnings: { messages: string[]; dropped: number } = { messages: [], dropped: 0 };
const completed: string[] = [];
const screenshots: string[] = [];
let browser: Browser | undefined;
let succeeded = false;

async function capture(page: Page, name: string): Promise<void> {
  const filename = `${name}.png`;
  await page.screenshot({ path: join(artifacts, filename), fullPage: true });
  screenshots.push(filename);
}

try {
  browser = await chromium.launch();
  // A deadline bounds owned server startup; it is not a performance assertion.
  const readiness = await browser.newPage();
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const response = await readiness.goto(origin, {
          waitUntil: 'domcontentloaded',
          timeout: 2000,
        });
        if (response?.ok()) {
          break;
        }
      } catch {
        // Astro and its same-origin proxy may still be starting.
      }
      assert(Date.now() < deadline, 'Owned development server did not become ready');
      await delay(250);
    }
  } finally {
    await readiness.close();
  }

  for (const profile of [
    { name: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
    { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  ]) {
    const { name, ...contextOptions } = profile;
    const context = await browser.newContext({
      ...contextOptions,
      deviceScaleFactor: 1,
      recordVideo: { dir: join(artifacts, 'video'), size: profile.viewport },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => {
      if (errors.length < 50) {
        errors.push(`${name}: ${error.message.slice(0, 1000)}`);
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && errors.length < 50) {
        errors.push(`${name}: ${message.text().slice(0, 1000)}`);
      }
      if (message.type() === 'warning') {
        if (warnings.messages.length < 50) {
          warnings.messages.push(`${name}: ${message.text().slice(0, 1000)}`);
        } else {
          warnings.dropped++;
        }
      }
    });
    try {
      const response = await page.goto(origin);
      assert(response?.ok(), 'Game document failed');
      await page.getByRole('heading', { name: 'GeoRoids', exact: true }).waitFor();
      await page.getByLabel('Pilot name', { exact: true }).fill(`CI ${profile.name}`);
      await capture(page, `${profile.name}-title`);
      await page.getByRole('button', { name: 'Enter Game', exact: true }).click();
      const canvas = page.getByLabel('GeoRoids playfield', { exact: true });
      await canvas.waitFor({ state: 'visible' });
      await page.keyboard.press('Space');
      await page.locator('#spawn-fly-in').waitFor({ state: 'hidden' });
      assert(
        await canvas.evaluate(
          (element) =>
            element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0
        )
      );
      if (profile.hasTouch) {
        await canvas.tap({ position: { x: 150, y: 150 } });
      } else {
        await canvas.click({ position: { x: 150, y: 150 } });
      }
      await page.keyboard.press('Space');
      await capture(page, `${profile.name}-flight`);
      completed.push(`${profile.name}: join and playfield input sent`);

      await page.getByRole('button', { name: /^Open universe map/u }).click();
      const map = page.getByRole('dialog', { name: 'Universe map', exact: true });
      await map.waitFor({ state: 'visible' });
      await capture(page, `${profile.name}-map`);
      await map.getByRole('button', { name: 'Close', exact: true }).click();
      await map.waitFor({ state: 'hidden' });
      completed.push(`${profile.name}: map opened and closed`);

      for (const route of ['wiki/', 'debug']) {
        const result = await page.goto(`${origin}/${route}`);
        assert(result?.ok(), `${route} document failed`);
        await page.locator('h1:visible').first().waitFor();
        await capture(page, `${profile.name}-${route.replace('/', '')}`);
        completed.push(`${profile.name}: /${route}`);
      }
    } catch (error) {
      await capture(page, `${profile.name}-failure`).catch(() => undefined);
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, [], 'Browser errors occurred');
  succeeded = true;
} catch (error) {
  errors.push(error instanceof Error ? error.message.slice(0, 2000) : 'Unknown browser failure');
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    succeeded = false;
    process.exitCode = 1;
    errors.push('Browser cleanup failed');
  }
  await writeFile(
    join(artifacts, 'receipt.json'),
    `${JSON.stringify(
      {
        candidateSha,
        workflowSha: process.env['BROWSER_SMOKE_WORKFLOW_SHA'],
        runId: process.env['GITHUB_RUN_ID'],
        browser: browser?.version() ?? null,
        node: process.version,
        completed,
        screenshots,
        errors,
        warnings: warnings.messages,
        warningsDropped: warnings.dropped,
        success: succeeded,
        limitation:
          'Hosted Chromium viewport checks do not certify physical touch, audio, iPhone memory pressure or remote motion quality.',
      },
      null,
      2
    )}\n`
  );
}
