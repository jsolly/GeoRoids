import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private touchContext: BrowserContext | null = null;
  private page: Page | null = null;
  private pages: Page[] = [];

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=VizDisplayCompositor',
        // Keep the game loop (requestAnimationFrame) and timers running at full
        // speed even when the headless page is treated as backgrounded. Without
        // these, Chromium throttles rAF to ~1fps under load, which starves the
        // client-side collision/boundary checks and makes placement-based tests
        // flaky in long suite runs.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-ipc-flooding-protection',
      ],
    });
    this.context = await this.browser.newContext({ hasTouch: false });
  }

  async createPage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    if (!this.browser || !this.context) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    let context = this.context;
    if (options.hasTouch) {
      this.touchContext ??= await this.browser.newContext({ hasTouch: true, deviceScaleFactor: 2 });
      context = this.touchContext;
    }
    const page = await context.newPage();
    this.page = page;
    this.pages.push(page);
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Set user agent for consistent behavior
    await page.setExtraHTTPHeaders({
      'User-Agent': 'GeoAsteroids-Test-Bot/1.0',
    });

    // Keep the page foregrounded so the game loop is not throttled.
    await page.bringToFront();

    return page;
  }

  /** Replace the scenario page when a test needs a different input device. */
  async recreatePage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    await this.closeAllPages();
    return this.createPage(options);
  }

  /** Close every page before the next scenario begins. */
  async closeAllPages(): Promise<void> {
    for (const page of this.pages) {
      await page.close();
    }
    this.pages = [];
    this.page = null;
  }

  async cleanup(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.touchContext = null;
    this.pages = [];
    this.page = null;
  }

  getCurrentPage(): Page | null {
    return this.page;
  }
}
