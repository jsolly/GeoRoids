import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  type Page,
} from 'playwright';

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pages: Page[] = [];
  private readonly pageContexts = new Map<Page, BrowserContext>();
  private contexts = new Set<BrowserContext>();
  private cleanupFailed = false;
  private readonly pageErrors: Error[] = [];

  async initialize(browserType: BrowserType = chromium): Promise<void> {
    this.browser = await browserType.launch({
      headless: true,
      args:
        browserType === chromium
          ? [
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
            ]
          : [],
    });
  }

  async createPage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    if (this.cleanupFailed) {
      await this.closeAllPages();
    }
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initialize() first.');
    }

    // Each page is a separate pilot. In particular, private resume tokens in
    // localStorage must never make a second pilot take over the first pilot's
    // connection. Reloads still happen inside this context and retain that
    // pilot's session as expected.
    const context = await this.browser.newContext(
      options.hasTouch ? { hasTouch: true, deviceScaleFactor: 2 } : { hasTouch: false }
    );
    this.contexts.add(context);
    let page: Page;
    try {
      page = await context.newPage();
    } catch (error: unknown) {
      let closeError: unknown;
      try {
        await context.close();
        this.contexts.delete(context);
      } catch (writeError: unknown) {
        closeError = writeError;
      }
      if (closeError) {
        const closeMessage =
          closeError instanceof Error ? closeError.message : 'unknown close failure';
        throw new Error(`Browser context failed while creating a scenario page (${closeMessage})`, {
          cause: error,
        });
      }
      throw error;
    }

    this.page = page;
    this.pages.push(page);
    this.pageContexts.set(page, context);
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

  /** Alias for closePage — closes every page and owned context in this manager. */
  async closeAllPages(): Promise<void> {
    const failures: unknown[] = [];
    const remaining: Page[] = [];
    for (const page of this.pages) {
      try {
        await page.close();
        this.pageContexts.delete(page);
      } catch (error: unknown) {
        failures.push(error);
        remaining.push(page);
      }
    }
    this.pages = remaining;
    this.page = remaining.at(-1) ?? null;

    // Do not close a context while one of its pages still needs a retry. A
    // context with no remaining page is fully owned by this manager and is
    // closed here rather than accumulating until the file-level cleanup.
    const activeContexts = new Set(
      remaining.map((page) => this.pageContexts.get(page)).filter(this.isContext)
    );
    const remainingContexts = new Set<BrowserContext>();
    for (const context of this.contexts) {
      if (activeContexts.has(context)) {
        remainingContexts.add(context);
        continue;
      }
      try {
        await context.close();
      } catch (error: unknown) {
        failures.push(error);
        remainingContexts.add(context);
      }
    }
    this.contexts = remainingContexts;

    this.cleanupFailed = remaining.length > 0 || remainingContexts.size > 0;
    failures.push(...this.pageErrors.splice(0));
    if (failures.length > 0) {
      throw new AggregateError(failures, `Scenario pages failed with ${failures.length} error(s)`);
    }
  }

  /** Open an additional independent browser context for a multi-client scenario. */
  createAdditionalPage(options: { hasTouch?: boolean } = {}): Promise<Page> {
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

    // closeAllPages normally drains these. A page whose close failed remains
    // associated with its context, so cleanup retries every context explicitly
    // before closing the browser and retains ownership if anything fails.
    for (const context of this.contexts) {
      try {
        await context.close();
        this.contexts.delete(context);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    try {
      await this.browser?.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    failures.push(...this.pageErrors.splice(0));
    if (failures.length === 0 && !this.browser?.isConnected()) {
      this.contexts.clear();
      this.pageContexts.clear();
      this.browser = null;
      this.pages = [];
      this.page = null;
      this.cleanupFailed = false;
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `Browser cleanup failed with ${failures.length} error(s)`);
    }
  }

  getCurrentPage(): Page | null {
    return this.page;
  }

  private isContext(value: BrowserContext | undefined): value is BrowserContext {
    return value !== undefined;
  }
}
