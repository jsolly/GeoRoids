import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { articles } from '../../../../src/wiki/content';
import { media } from '../../../../src/wiki/media';
import { TestConfig } from '../../utils/test-config';

test('pilots find rules, follow related entries, and control demonstrations on desktop and mobile', async () => {
  const browser = await chromium.launch({ headless: true });
  const output = resolve('tests/integration/browser/screenshots');
  await mkdir(output, { recursive: true });
  const consoleMessages: string[] = [];
  const errors: string[] = [];
  const sockets: string[] = [];
  const failedResponses: string[] = [];
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type())) {
      consoleMessages.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => sockets.push(socket.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  try {
    await page.goto(`${TestConfig.GAME_URL}/wiki`);
    await page.locator('.ship-card').first().waitFor();
    expect(await page.locator('.ship-card').count()).toBe(5);
    expect(await page.locator('.demo img[src$=".gif"]').count()).toBe(0);
    await page.screenshot({ path: resolve(output, 'wiki-desktop.png'), fullPage: true });
    await page.locator('.comparison summary').click();
    expect(await page.locator('tbody tr').count()).toBe(5);
    await page.locator('#wiki-search').fill('shield');
    expect(await page.locator('#search-status').textContent()).toBe(
      `${await page.locator('.topic-card').count()} matching entries`
    );
    expect(await page.locator('.topic-card').count()).toBeGreaterThan(0);
    await page.locator('#wiki-search').fill('<img src=x onerror=alert(1)>');
    expect(await page.locator('.empty-state').isVisible()).toBe(true);
    expect(await page.locator('#content img').count()).toBe(0);
    await page.locator('#reset-results').click();
    expect(await page.locator('#search-status').textContent()).toBe('');
    await page.locator('.ship-card[href="#hauler"]').click();
    await expect.poll(() => page.locator('h1').textContent()).toBe('Hauler');
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('h1').textContent()).toBe('Hauler');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('content');
    expect(
      await page.locator('#content').evaluate((element) => getComputedStyle(element).outlineStyle)
    ).toBe('solid');
    await page.locator('#wiki-search').fill('hauler');
    await page.locator('.topic-card[href="#hauler"]').click();
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Hauler');
    expect(await page.locator('#wiki-search').inputValue()).toBe('');
    expect(await page.locator('#search-status').textContent()).toBe('');
    await page.locator('.media-toggle').first().click();
    expect(await page.locator('.media-toggle').first().getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(/\.gif$/);
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.demo img')].every(
        (image) => image.complete && image.naturalWidth > 0
      )
    );
    await page.locator('.media-toggle').first().click();
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(/\.png$/);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.media-toggle').first().click();
    expect(await page.locator('.media-toggle').first().getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(/\.gif$/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() => page.locator('.media-toggle').first().getAttribute('aria-pressed'))
      .toBe('false');
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(/\.png$/);
    await page.screenshot({ path: resolve(output, 'wiki-hauler-desktop.png'), fullPage: true });
    await page.locator('.related-link').first().click();
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Controls');
    await page.goBack();
    await expect.poll(() => page.locator('h1').textContent()).toBe('Hauler');
    await page.goto(`${TestConfig.GAME_URL}/wiki/#missing-entry`);
    await expect.poll(() => page.locator('h1').textContent()).toContain('not in the manual');
    for (const article of articles) {
      await page.goto(`${TestConfig.GAME_URL}/wiki/#${article.id}`);
      await expect.poll(() => page.locator('h1').textContent()).toBe(article.title);
      expect(await page.locator('.article-body section').count()).toBe(article.sections.length);
      expect(
        await page
          .locator('.demo')
          .evaluateAll((figures) => figures.map((figure) => figure.getAttribute('data-media')))
      ).toEqual(article.media);
      for (const id of article.media) {
        const definition = media[id];
        if (!definition) {
          throw new Error(`Missing demonstration definition: ${id}`);
        }
        const figure = page.locator(`.demo[data-media="${id}"]`);
        expect(await figure.locator('img').getAttribute('src')).toBe(`/wiki/media/${id}.png`);
        expect(await figure.locator('img').getAttribute('alt')).toBe(definition.alt);
        expect(await figure.locator('figcaption').textContent()).toContain(definition.caption);
      }
    }
    for (const id of Object.keys(media)) {
      for (const extension of ['gif', 'png']) {
        const response = await page.request.get(
          `${TestConfig.GAME_URL}/wiki/media/${id}.${extension}`
        );
        expect(response.ok()).toBe(true);
        expect(response.headers()['content-type']).toContain('image/');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${TestConfig.GAME_URL}/wiki/`);
    await page.locator('.ship-card').first().waitFor();
    expect(await page.locator('#navigation').getAttribute('open')).toBeNull();
    await page.locator('#navigation summary').click();
    await page.locator('#article-nav a[href="#warden"]').click();
    await expect.poll(() => page.locator('h1').textContent()).toBe('Warden');
    expect(await page.locator('#navigation').getAttribute('open')).toBeNull();
    await page.locator('.media-toggle').first().click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.demo img')].every(
        (image) => image.complete && image.naturalWidth > 0
      )
    );
    await page.locator('.media-toggle').first().click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: resolve(output, 'wiki-warden-mobile.png'), fullPage: true });
    await page.locator('.breadcrumb a').click();
    await page.screenshot({ path: resolve(output, 'wiki-mobile.png'), fullPage: true });
    await page.locator('#wiki-search').fill('fuel');
    expect(await page.locator('.topic-card').count()).toBeGreaterThan(0);
    await page.locator('#clear-search').click();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    // Vite's development refresh connection is expected; the manual must not
    // open gameplay or forwarded-log connections. Production has no HMR.
    expect(sockets.filter((url) => ['/ws', '/logs'].includes(new URL(url).pathname))).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleMessages).toEqual([]);
    expect(failedResponses).toEqual([]);
    const entryPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    entryPage.on('console', (message) => {
      if (['warning', 'error'].includes(message.type())) {
        consoleMessages.push(`Game entry: ${message.text()}`);
      }
    });
    entryPage.on('pageerror', (error) => errors.push(`Game entry: ${error.message}`));
    await entryPage.goto(TestConfig.GAME_URL);
    await entryPage.locator('.manual-entry a').waitFor();
    await entryPage.screenshot({
      path: resolve(output, 'wiki-game-entry-desktop.png'),
      fullPage: true,
    });
    await entryPage.setViewportSize({ width: 390, height: 844 });
    await entryPage.screenshot({
      path: resolve(output, 'wiki-game-entry-mobile.png'),
      fullPage: true,
    });
    await entryPage.locator('.manual-entry a').click();
    await entryPage.locator('.ship-card').first().waitFor();
    expect(new URL(entryPage.url()).pathname).toBe('/wiki/');
    await entryPage.close();
    expect(errors).toEqual([]);
    expect(consoleMessages).toEqual([]);
    await writeFile(
      resolve(output, 'wiki-verification.json'),
      JSON.stringify(
        {
          routes: ['/wiki', '/wiki/', ...articles.map((article) => `/wiki/#${article.id}`)],
          viewports: ['1280x900', '390x844'],
          interactions: [
            'search',
            'empty state',
            'clear',
            'ship comparison',
            'same-article search result',
            'related entries',
            'history',
            'deep links',
            'unknown entry',
            'GIF play/pause',
            'reduced-motion change stops active GIFs',
            'mobile navigation',
            'keyboard focus',
          ],
          consoleMessages,
          errors,
          sockets,
          failedResponses,
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
});
