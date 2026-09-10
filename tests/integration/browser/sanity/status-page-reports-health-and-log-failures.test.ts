import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test('status controls show actual log writes and reject unhealthy responses on both viewport sizes', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Status test page unavailable');
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${TestConfig.SERVER_URL}/status`);
    await page.waitForFunction(() =>
      document.getElementById('serverHealth')?.textContent?.includes('Server is healthy')
    );
    await page.waitForFunction(() =>
      document.getElementById('loggingHealth')?.textContent?.includes('Connected log clients:')
    );
    await page.getByRole('button', { name: 'Send Server Log', exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById('serverLogBtn')?.textContent?.includes('Written')
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  }
  await page.route('**/health', (route) =>
    route.fulfill({
      status: 503,
      json: { status: 'healthy', players: 0, uptime: 1, timestamp: new Date().toISOString() },
    })
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById('serverHealth')?.textContent?.includes('HTTP 503')
  );
  expect(await page.locator('#serverHealth').textContent()).not.toContain('Server is healthy');
  await page.route('**/test-server-log', (route) =>
    route.fulfill({ status: 500, json: { status: 'success', message: 'not actually written' } })
  );
  await page.getByRole('button', { name: 'Send Server Log', exact: true }).click();
  await page.waitForFunction(() =>
    document.getElementById('serverLogBtn')?.textContent?.includes('Failed')
  );
  expect(await page.locator('#messageLog').textContent()).toContain('HTTP 500');
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('#serverLogBtn')?.disabled
  );
  expect(errors).toEqual([]);
});

test('logging losses stay visible and missing counters never look like zero loss', async () => {
  const page = browserManager.getCurrentPage();
  if (!page) {
    throw new Error('Status test page unavailable');
  }
  let logging: Record<string, unknown> | undefined = {
    activeLogClients: 3,
    clientIngress: {
      queuedBytes: 40,
      droppedRecords: 2,
      writeErrors: 1,
      invalid: 4,
      rateLimited: 5,
      clientReportedDroppedRecords: 6,
    },
    serverWriter: {
      queuedBytes: 20,
      droppedRecords: 1,
      writeErrors: 2,
      stdoutDroppedRecords: 7,
      stdoutWriteErrors: 8,
    },
  };
  await page.route('**/health', (route) =>
    route.fulfill({
      json: {
        status: 'healthy',
        players: 0,
        uptime: 1,
        timestamp: new Date().toISOString(),
        logging,
      },
    })
  );
  await page.goto(`${TestConfig.SERVER_URL}/status`);
  await page.waitForFunction(() =>
    document.getElementById('loggingHealth')?.textContent?.includes('Connected log clients: 3')
  );
  const panel = page.locator('#loggingHealth');
  expect(await panel.textContent()).toContain('Queued bytes: client 40, server 20');
  expect(await panel.locator('.warn').allTextContents()).toEqual([
    'Dropped file records since startup: 3',
    'Browser-reported dropped records: 6',
    'File write errors since startup: 3',
    'Standard-output records dropped: 7',
    'Standard-output write errors: 8',
    'Rejected client records: invalid 4, rate limited 5',
  ]);
  const repeatedAnnouncements = await page.evaluate(async () => {
    const region = document.getElementById('loggingHealth');
    if (!region) {
      throw new Error('Logging health region missing');
    }
    let changes = 0;
    const observer = new MutationObserver((records) => {
      changes += records.length;
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    try {
      await (window as unknown as { checkServerHealth: () => Promise<void> }).checkServerHealth();
      await Promise.resolve();
      return changes;
    } finally {
      observer.disconnect();
    }
  });
  expect(repeatedAnnouncements).toBe(0);

  logging = undefined;
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById('loggingHealth')?.textContent?.includes('invalid or missing counters')
  );
  expect(await panel.textContent()).not.toContain('since startup: 0');
});
