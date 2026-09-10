import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private touchContext: BrowserContext | null = null;
  private page: Page | null = null;
  private pages: Page[] = [];
  private pageCleanupFailed = false;
  private readonly pageErrors: Error[] = [];

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
    if (this.pageCleanupFailed) {
      await this.closeAllPages();
    }
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
    const onPageError = (error: Error) => this.pageErrors.push(error);
    page.on('pageerror', onPageError);
    page.once('close', () => page.off('pageerror', onPageError));
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Set user agent for consistent behavior
    await page.setExtraHTTPHeaders({
      'User-Agent': 'GeoAsteroids-Test-Bot/1.0',
    });

    // Keep the page foregrounded so the game loop is not throttled.
    await page.bringToFront();

    return page;
  }

  async closePage(): Promise<void> {
    await this.closeAllPages();
  }

  /** Replace the scenario page when a test needs a different input device. */
  async recreatePage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    await this.closeAllPages();
    return this.createPage(options);
  }

  /** Alias for closePage — closes every page opened in this manager. */
  async closeAllPages(): Promise<void> {
    const failures: unknown[] = [];
    const remaining: Page[] = [];
    for (const page of this.pages) {
      try {
        await page.close();
      } catch (error: unknown) {
        failures.push(error);
        remaining.push(page);
      }
    }
    this.pages = remaining;
    this.page = remaining.at(-1) ?? null;
    this.pageCleanupFailed = remaining.length > 0;
    failures.push(...this.pageErrors.splice(0));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Scenario pages failed with ${failures.length} error(s)`);
    }
  }

  /** Open an additional browser tab for multi-client scenarios. */
  async createAdditionalPage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    return this.createPage(options);
  }

  /** Returns the first and second pages for two-client tests. */
  getTwoClientPages(): { first: Page; second: Page } {
    const [first, second] = this.pages;
    if (!first || !second) {
      throw new Error(
        'Expected two pages — call createAdditionalPage() after the first createPage()'
      );
    }
    return { first, second };
  }

  async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.closeAllPages();
    } catch (error: unknown) {
      if (error instanceof AggregateError) {
        failures.push(...error.errors);
      } else {
        failures.push(error);
      }
    }

    for (const resource of [this.context, this.touchContext, this.browser]) {
      try {
        await resource?.close();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    failures.push(...this.pageErrors.splice(0));
    if (!this.browser?.isConnected()) {
      this.context = null;
      this.touchContext = null;
      this.browser = null;
      this.pages = [];
      this.page = null;
      this.pageCleanupFailed = false;
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `Browser cleanup failed with ${failures.length} error(s)`);
    }
  }

  getCurrentPage(): Page | null {
    return this.page;
  }
}
