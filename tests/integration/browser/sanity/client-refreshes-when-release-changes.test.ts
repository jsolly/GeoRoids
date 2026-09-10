import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { BrowserManager } from '../../utils/browser-manager';
import { checkViteServer } from '../../utils/health-checker';
import { ScreenshotManager } from '../../utils/screenshot-manager';
import { TestConfig } from '../../utils/test-config';

const browserManager = new BrowserManager();
const screenshots = new ScreenshotManager();
const current = 'a9755405dcfd546ace3e92b4dc8c3ff53d9bb598';
const next = 'b'.repeat(40);

beforeAll(async () => {
  if (!(await checkViteServer())) {
    throw new Error('Runner Vite origin is unavailable');
  }
  screenshots.ensureScreenshotsDirectory();
  await browserManager.initialize();
});
afterEach(async () => browserManager.closeAllPages());
afterAll(async () => browserManager.cleanup());

/** Poll from the runner: browser timers are deliberately controlled by page.clock. */
async function waitForProbe(page: Page, minimum: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() =>
      Number(document.documentElement.dataset['probes'] ?? 0)
    );
    if (count >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Browser did not finish release probe ${minimum}`);
}

// The dev-only fixture imports the actual production watcher, since its normal
// entry intentionally does not run under Vite development. Only the document
// and HEAD metadata are controlled; fetch, tab storage and reload are real.
// No game connection or game-server state is mocked, started or reset here.
const fixture = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,"><title>GeoRoids release refresh fixture</title>
<style>body{margin:0;background:#080b10;color:#e8d5a3;font:18px system-ui;padding:32px;box-sizing:border-box}main{max-width:620px}h1{font-size:28px}p{line-height:1.5}code{overflow-wrap:anywhere}</style></head>
<body><main><h1>GeoRoids client update check</h1><p>Controlled local release metadata; real browser refresh.</p>
<p>Document loads: <strong id="loads"></strong></p><p>Published client: <code id="release"></code></p></main>
<script type="module">
import { watchClientRelease } from '/src/release/clientReleaseWatcher.ts';
const loads = Number(sessionStorage.getItem('release-fixture-loads') || 0) + 1;
sessionStorage.setItem('release-fixture-loads', String(loads));
document.querySelector('#loads').textContent = String(loads);
document.documentElement.dataset.probes = '0';
watchClientRelease('${current.slice(0, 7)}', {
  fetch: async (input, init) => {
    const response = await window.fetch(input, init);
    document.querySelector('#release').textContent = response.headers.get('x-release-id') || 'unverified';
    document.documentElement.dataset.probes = String(Number(document.documentElement.dataset.probes) + 1);
    return response;
  },
  storage: sessionStorage,
  document,
  reload: () => {
    sessionStorage.setItem('release-fixture-reloads', String(Number(sessionStorage.getItem('release-fixture-reloads') || 0) + 1));
    window.location.reload();
  },
});
</script></body></html>`;

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(
    `${viewport.name} refreshes once for a confirmed client release and a cached old bundle cannot loop`,
    async () => {
      const page = await browserManager.createPage({ hasTouch: viewport.name === 'mobile' });
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
      let published = current;
      let documentRequests = 0;
      const headRequests: Array<{ url: string; method: string }> = [];
      const origin = new URL(TestConfig.GAME_URL).origin;
      await page.route(
        (url) => url.origin === origin && url.pathname === '/',
        async (route) => {
          const request = route.request();
          if (request.method() === 'HEAD') {
            headRequests.push({ url: request.url(), method: request.method() });
            await route.fulfill({
              status: 200,
              headers: { 'x-release-id': published, 'cache-control': 'no-store' },
              body: '',
            });
            return;
          }
          if (request.isNavigationRequest() && request.method() === 'GET') {
            documentRequests++;
            await route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
            return;
          }
          await route.continue();
        }
      );
      await page.clock.install({ time: new Date('2026-09-07T00:00:00Z') });
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await waitForProbe(page, 1);
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
      expect(await page.locator('#loads').textContent()).toBe('1');
      expect(documentRequests).toBe(1);
      published = next;
      await page.clock.runFor(30_000);
      await waitForProbe(page, 2);
      expect(documentRequests).toBe(1); // One changed observation cannot force reload.
      const navigation = page.waitForEvent(
        'framenavigated',
        (frame) => frame === page.mainFrame() && frame.url() === `${origin}/`
      );
      await page.clock.runFor(30_000);
      await navigation;
      await page.waitForLoadState('load');
      await waitForProbe(page, 1);
      expect(await page.locator('#loads').textContent()).toBe('2');
      expect(documentRequests).toBe(2);
      // Playwright's controlled clock replaces Performance APIs (navigation
      // entries are empty). The real main-frame navigation and second document
      // request above, plus this persisted callback count, prove actual reload.
      expect(await page.evaluate(() => sessionStorage.getItem('release-fixture-reloads'))).toBe(
        '1'
      );
      // Fixture deliberately keeps serving the old bundle after the new header:
      // its persisted per-bundle guard must stop another confirmed reload.
      await page.clock.runFor(30_000);
      await waitForProbe(page, 2);
      await page.clock.runFor(90_000);
      expect(documentRequests).toBe(2);
      expect(await page.locator('#loads').textContent()).toBe('2');
      expect(await page.evaluate(() => sessionStorage.getItem('release-fixture-reloads'))).toBe(
        '1'
      );
      expect(headRequests.length).toBeGreaterThanOrEqual(5);
      expect(
        headRequests.every((request) => request.url === `${origin}/` && request.method === 'HEAD')
      ).toBe(true);
      const screenshotPath = screenshots.getScreenshotPath(
        screenshots.getTimestampedFilename(`release-refresh-${viewport.name}`)
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const receipt = {
        route: `${origin}/`,
        fixture: 'local HTML and client HEAD metadata; actual watcher/fetch/reload',
        viewport,
        documentRequests,
        headRequests: headRequests.length,
        reloadCallbackCount: 1,
        mainFrameNavigationsAfterInitialLoad: 1,
        errors,
        warnings,
        screenshotPath,
      };
      writeFileSync(
        screenshotPath.replace(/\.png$/, '.json'),
        `${JSON.stringify(receipt, null, 2)}\n`
      );
      expect(errors).toEqual([]);
      expect(warnings).toEqual([]);
    },
    TestConfig.DEFAULT_TIMEOUT
  );
}
