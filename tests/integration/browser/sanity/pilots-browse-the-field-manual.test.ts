import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { readWikiArticles } from '../../../../scripts/wiki-content';
import { media } from '../../../../src/wiki/media';
import { TestConfig } from '../../utils/test-config';

const articles = readWikiArticles();
const GIF_SRC_SUFFIX_PATTERN = /\.gif$/u;
const PNG_SRC_SUFFIX_PATTERN = /\.png$/u;
const WHITESPACE_COLLAPSE_PATTERN = /\s+/gu;
const HAULER_LEGACY_TERMS_PATTERN = /Q latches|couple a second/u;

test('pilots find rules and see autoplay demonstrations on desktop and mobile', async () => {
  const browser = await chromium.launch({ headless: true });
  const output = resolve('tests/integration/browser/screenshots');
  await mkdir(output, { recursive: true });
  const consoleMessages: string[] = [];
  const errors: string[] = [];
  const sockets: string[] = [];
  const failedResponses: string[] = [];
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'no-preference',
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
    expect(await page.locator('.ship-card').count()).toBe(2);
    expect(await page.locator('.demo img[src$=".gif"]').count()).toBe(0);
    await page.screenshot({ path: resolve(output, 'wiki-desktop.png'), fullPage: true });
    const indexOffset = await page.evaluate(() => {
      const card = document.querySelector('.topic-card');
      if (!(card instanceof HTMLElement)) {
        return 0;
      }
      const y = Math.max(0, card.getBoundingClientRect().top + window.scrollY - 240);
      window.scrollTo(0, y);
      return window.scrollY;
    });
    expect(indexOffset).toBeGreaterThan(200);
    await expect.poll(() => page.evaluate(() => history.state?.wikiScrollY)).toBe(indexOffset);
    await page.reload();
    await page.locator('.topic-card').first().waitFor();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, indexOffset))
      .toBe(true);
    await page.locator('.topic-card').first().click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const articleOffset = await page.evaluate(() => {
      window.scrollTo(0, 480);
      return window.scrollY;
    });
    expect(articleOffset).toBeGreaterThan(200);
    await page.goBack();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, indexOffset))
      .toBe(true);
    await page.goForward();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, articleOffset))
      .toBe(true);
    await page.goBack();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, indexOffset))
      .toBe(true);
    await page.locator('.topic-card').first().click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, indexOffset))
      .toBe(true);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.locator('.comparison summary').click();
    expect(await page.locator('tbody tr').count()).toBe(2);
    await page.locator('#wiki-search').fill('furnace');
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
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(
      GIF_SRC_SUFFIX_PATTERN
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.demo img')].every(
        (image) => image.complete && image.naturalWidth > 0
      )
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.demo button').count()).toBe(0);
    await expect
      .poll(() => page.locator('.demo img').first().getAttribute('src'))
      .toMatch(PNG_SRC_SUFFIX_PATTERN);
    await page.goto(`${TestConfig.GAME_URL}/wiki/#scout`);
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Scout');
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(
      PNG_SRC_SUFFIX_PATTERN
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Hauler');
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(
      GIF_SRC_SUFFIX_PATTERN
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => page.locator('.demo img').first().getAttribute('src'))
      .toMatch(PNG_SRC_SUFFIX_PATTERN);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => page.locator('.demo img').first().getAttribute('src'))
      .toMatch(GIF_SRC_SUFFIX_PATTERN);
    const haulerContent = ((await page.locator('#content').textContent()) ?? '').replace(
      WHITESPACE_COLLAPSE_PATTERN,
      ' '
    );
    expect(haulerContent).toContain('Press E near a rock or spider to latch');
    expect(haulerContent).toContain('Cargo keeps its momentum');
    expect(haulerContent).not.toMatch(HAULER_LEGACY_TERMS_PATTERN);
    expect(haulerContent).toContain('Boost Coupling E');
    expect(haulerContent).toContain('then E again to ignite autonomous delivery');
    await page.screenshot({ path: resolve(output, 'wiki-hauler-desktop.png'), fullPage: true });
    const haulerOffset = await page.evaluate(() => {
      const link = document.querySelector('.related-link');
      if (!(link instanceof HTMLElement)) {
        return 0;
      }
      const y = Math.max(0, link.getBoundingClientRect().top + window.scrollY - 280);
      window.scrollTo(0, y);
      return window.scrollY;
    });
    expect(haulerOffset).toBeGreaterThan(200);
    await page.locator('.related-link').first().click();
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Controls');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: resolve(output, 'wiki-controls-desktop.png'), fullPage: true });
    await page.goBack();
    await expect.poll(() => page.locator('h1').textContent()).toBe('Hauler');
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, haulerOffset))
      .toBe(true);
    await page.goto(`${TestConfig.GAME_URL}/wiki/#missing-entry`);
    await expect.poll(() => page.locator('h1').textContent()).toContain('not in the manual');
    for (const article of articles) {
      await page.goto(`${TestConfig.GAME_URL}/wiki/#${article.id}`);
      await expect.poll(() => page.locator('h1').textContent()).toBe(article.title);
      if (article.id === 'satellites') {
        await page.screenshot({
          path: resolve(output, 'wiki-satellite-inventory-desktop.png'),
          fullPage: true,
        });
      }
      const articleMedia = article.media;
      expect(await page.locator('.game-reference section').count()).toBe(article.sections.length);
      expect(
        (await page.locator('.article-body').textContent())?.replace(
          WHITESPACE_COLLAPSE_PATTERN,
          ' '
        )
      ).toContain(article.searchText.split(' ').slice(0, 2).join(' '));
      expect(
        await page
          .locator('.demo')
          .evaluateAll((figures) => figures.map((figure) => figure.getAttribute('data-media')))
      ).toEqual(articleMedia);
      const scorecard = page.locator('.ship-scorecard');
      if (article.category === 'Ships') {
        expect(await scorecard.count()).toBe(1);
        await scorecard.locator('.ship-radar svg').waitFor();
        expect(await scorecard.locator('.ship-radar svg').count()).toBe(1);
        expect(await scorecard.locator('.stat-bubbles').count()).toBe(7);
        expect(await scorecard.locator('.stat-bubble').count()).toBe(35);
        expect(await scorecard.locator('.stat-bubble.filled').count()).toBeGreaterThanOrEqual(7);
        expect(await scorecard.getAttribute('aria-labelledby')).toBe(
          `${article.id}-scorecard-title`
        );
        expect(await scorecard.locator('dt').allTextContents()).toEqual([
          'Hull',
          'Size',
          'Thrust',
          'Speed cap',
          'Turn rate',
          'Shot interval',
          'E cooldown',
        ]);
        expect(await page.locator('.ability-card').count()).toBe(articleMedia.length);
      } else {
        expect(await scorecard.count()).toBe(0);
        expect(await page.locator('.ability-card').count()).toBe(0);
      }
      expect(await page.locator('.topic-demo-card').count()).toBe(articleMedia.length);
      for (const id of articleMedia) {
        const definition = media[id];
        if (!definition) {
          throw new Error(`Missing demonstration definition: ${id}`);
        }
        const figure = page.locator(`.demo[data-media="${id}"]`);
        expect(await figure.locator('img').getAttribute('src')).toBe(`/wiki/media/${id}.gif`);
        expect(await figure.locator('button').count()).toBe(0);
        expect(await figure.locator('img').getAttribute('alt')).toBe(definition.alt);
        expect(await figure.locator('figcaption').count()).toBe(0);
        expect(
          await figure
            .locator('img')
            .evaluate((image) => image.closest('.topic-demo-card') !== null)
        ).toBe(true);
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
    const mobileOffset = await page.evaluate(() => {
      const card = document.querySelector('.topic-card');
      if (!(card instanceof HTMLElement)) {
        return 0;
      }
      const y = Math.max(0, card.getBoundingClientRect().top + window.scrollY - 240);
      window.scrollTo(0, y);
      return window.scrollY;
    });
    expect(mobileOffset).toBeGreaterThan(200);
    await page.locator('.topic-card').first().click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const mobileArticleOffset = await page.evaluate(() => {
      window.scrollTo(0, 320);
      return window.scrollY;
    });
    expect(mobileArticleOffset).toBeGreaterThan(200);
    await page.goBack();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, mobileOffset))
      .toBe(true);
    await page.goForward();
    await expect
      .poll(() => page.evaluate((y) => Math.abs(window.scrollY - y) <= 1, mobileArticleOffset))
      .toBe(true);
    await page.goto(`${TestConfig.GAME_URL}/wiki/`);
    await page.locator('.ship-card').first().waitFor();
    expect(await page.locator('#navigation').getAttribute('open')).toBeNull();
    await page.locator('#navigation summary').click();
    await page.locator('#article-nav a[href="#scout"]').click();
    await expect.poll(() => page.locator('h1').textContent()).toBe('Scout');
    expect(await page.locator('#navigation').getAttribute('open')).toBeNull();
    expect(await page.locator('.demo button').count()).toBe(0);
    expect(await page.locator('.demo img').first().getAttribute('src')).toMatch(
      GIF_SRC_SUFFIX_PATTERN
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>('.demo img')].every(
        (image) => image.complete && image.naturalWidth > 0
      )
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: resolve(output, 'wiki-scout-mobile.png'), fullPage: true });
    await page.locator('.ship-rating-guide summary').click();
    expect(await page.locator('.ship-rating-guide p').isVisible()).toBe(true);
    expect(await page.locator('.ship-rating-guide p').textContent()).toContain('Smaller size');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(() =>
        page.locator('.ship-radar').evaluate((element) => {
          const svg = element.querySelector('svg');
          return svg ? Math.abs(svg.getBoundingClientRect().width - element.clientWidth) : 999;
        })
      )
      .toBeLessThan(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.locator('.ship-radar').evaluate((element) => {
          const svg = element.querySelector('svg');
          return svg ? Math.abs(svg.getBoundingClientRect().width - element.clientWidth) : 999;
        })
      )
      .toBeLessThan(1);
    await page.goto(`${TestConfig.GAME_URL}/wiki/#hauler`);
    await expect.poll(() => page.locator('.article-header h1').textContent()).toBe('Hauler');
    expect(await page.locator('#content').textContent()).toContain('Boost Coupling E');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({ path: resolve(output, 'wiki-hauler-mobile.png'), fullPage: true });
    await page.goto(`${TestConfig.GAME_URL}/wiki/#controls`);
    expect(
      (await page.locator('#content').textContent())?.replace(WHITESPACE_COLLAPSE_PATTERN, ' ')
    ).toContain('Hold and drag one finger to steer');
    await page.screenshot({ path: resolve(output, 'wiki-controls-mobile.png'), fullPage: true });
    await page.goto(`${TestConfig.GAME_URL}/wiki/#satellites`);
    await expect.poll(() => page.locator('h1').textContent()).toBe('Satellites and pickups');
    await page.screenshot({
      path: resolve(output, 'wiki-satellite-inventory-mobile.png'),
      fullPage: true,
    });
    await page.locator('.breadcrumb a').click();
    await page.screenshot({ path: resolve(output, 'wiki-mobile.png'), fullPage: true });
    await page.locator('#wiki-search').fill('minerals');
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
            'GIF autoplay without playback controls',
            'reduced-motion and hidden-tab changes stop active GIFs and visible return resumes them',
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
