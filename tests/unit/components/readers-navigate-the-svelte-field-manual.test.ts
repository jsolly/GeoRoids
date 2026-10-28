import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readWikiArticles } from '../../../scripts/wiki-content';
import { SHIP } from '../../../shared/constants/gameplay';
import { getShipKit, listShipKits } from '../../../shared/shipKits';
import WikiShell from '../../../src/components/wiki/WikiShell.svelte';
import { serializeKitHullSvg } from '../../../src/entities/ship/hullOutlines';
import type { WikiArticle } from '../../../src/wiki/article';
import { shipRatings } from '../../../src/wiki/shipScorecard';

const charts = vi.hoisted(() => ({ mount: vi.fn(), dispose: vi.fn() }));
vi.mock('../../../src/wiki/shipScorecard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/wiki/shipScorecard')>()),
  mountShipRadar: (...args: unknown[]) => {
    charts.mount(...args);
    return charts.dispose;
  },
}));
const articles = readWikiArticles();
let shell: ReturnType<typeof mount> | undefined;
let scrollY = 0;
async function settle() {
  flushSync();
  await Promise.resolve();
  flushSync();
  await Promise.resolve();
}
async function show(hash: string) {
  history.replaceState({}, '', `/wiki/${hash}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await settle();
}
beforeEach(() => {
  vi.useFakeTimers();
  charts.mount.mockClear();
  charts.dispose.mockClear();
  document.body.innerHTML = '';
  scrollY = 0;
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  vi.spyOn(window, 'scrollTo').mockImplementation((_x, y) => {
    if (typeof y === 'number') {
      scrollY = y;
    }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 16)
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  history.replaceState({}, '', '/wiki/');
});
afterEach(async () => {
  if (shell) {
    await unmount(shell);
  }
  shell = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function start() {
  shell = mount(WikiShell, { target: document.body, props: { articles } });
  await settle();
}

test('readers search without changing the route and same-hash navigation returns to its beginning', async () => {
  await start();
  await show('#controls');
  expect(document.querySelectorAll('[data-panel]')).toHaveLength(1);
  expect(document.title).toBe('Controls | GeoRoids field manual');
  const input = document.querySelector<HTMLInputElement>('#wiki-search');
  if (!input) {
    throw new Error('Search input missing');
  }
  scrollY = 320;
  window.dispatchEvent(new Event('scroll'));
  input.value = 'hauler';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(location.hash).toBe('#controls');
  const result = document.querySelector('[data-panel="search"] .topic-card[href="#hauler"]');
  expect(result?.querySelector('h2')?.textContent).toContain('Hauler');
  expect(result?.querySelector('.card-category')?.textContent).toBe('Ships');
  document.querySelector<HTMLAnchorElement>('a[href="#controls"]')?.click();
  await settle();
  expect(input.value).toBe('');
  expect(document.querySelector('[data-panel="article"]')?.id).toBe('controls');
  expect(scrollY).toBe(0);
});

test('unknown and malformed hashes keep the manual not-found behavior', async () => {
  await start();
  for (const hash of ['#does-not-exist', '#%E0%A4%A']) {
    await show(hash);
    expect(document.querySelectorAll('[data-panel]')).toHaveLength(1);
    expect(document.body.textContent).toContain('That entry is not in the manual.');
    expect(document.title).toBe('Entry not found | GeoRoids field manual');
  }
  await show('#content');
  expect(document.querySelector('[data-panel="overview"]')).not.toBeNull();
});

test('active articles own their chart and animation and release charts and timers on navigation and unmount', async () => {
  await start();
  await show('#hauler');
  expect(charts.mount).toHaveBeenCalledExactlyOnceWith(
    document.querySelector('#hauler .ship-radar'),
    'hauler'
  );
  expect(document.querySelector<HTMLImageElement>('.demo img')?.getAttribute('src')).toBe(
    '/wiki/media/hauler.gif'
  );
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(document.querySelector<HTMLImageElement>('.demo img')?.getAttribute('src')).toBe(
    '/wiki/media/hauler.png'
  );
  await show('#controls');
  expect(charts.dispose).toHaveBeenCalledTimes(1);
  scrollY = 120;
  window.dispatchEvent(new Event('scroll'));
  const remember = vi.spyOn(history, 'replaceState');
  if (!shell) {
    throw new Error('Manual is not mounted');
  }
  await unmount(shell);
  shell = undefined;
  const writes = remember.mock.calls.length;
  const scrolls = vi.mocked(window.scrollTo).mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(remember).toHaveBeenCalledTimes(writes);
  expect(window.scrollTo).toHaveBeenCalledTimes(scrolls);
});

test('overview never mounts inactive radars and same-hash navigation retains the active chart', async () => {
  await start();
  expect(charts.mount).not.toHaveBeenCalled();
  await show('#hauler');
  const radar = document.querySelector('#hauler .ship-radar');
  await show('#hauler');
  expect(document.querySelector('#hauler .ship-radar')).toBe(radar);
  expect(charts.mount).toHaveBeenCalledExactlyOnceWith(radar, 'hauler');
  expect(charts.dispose).not.toHaveBeenCalled();
  if (!shell) {
    throw new Error('Manual is not mounted');
  }
  await unmount(shell);
  shell = undefined;
  expect(charts.dispose).toHaveBeenCalledTimes(1);
});

test('a reader opening the manual sees the hangar, the ship comparison and every field-note topic', async () => {
  await start();
  const overview = document.querySelector('[data-panel="overview"]');
  if (!overview) {
    throw new Error('Overview missing');
  }
  const kits = listShipKits();
  const shipCards = [...overview.querySelectorAll<HTMLAnchorElement>('#ships .ship-card')];
  expect(
    shipCards.map((card) => [card.getAttribute('href'), card.querySelector('h3')?.textContent])
  ).toEqual(kits.map((kit) => [`#${kit.id}`, kit.name]));
  const hulls = shipCards.map((card) => card.querySelector('img'));
  expect(hulls.map((hull) => hull?.getAttribute('src'))).toEqual(
    kits.map(
      (kit) =>
        `data:image/svg+xml,${encodeURIComponent(
          serializeKitHullSvg(kit.id, { background: false, title: false, width: 82, height: 82 })
        )}`
    )
  );
  expect(new Set(hulls.map((hull) => hull?.getAttribute('src'))).size).toBe(kits.length);
  for (const hull of hulls) {
    expect(hull?.getAttribute('alt')).toBe('');
    expect(hull?.getAttribute('width')).toBe('82');
  }
  const comparison = overview.querySelector('.table-scroll[role="region"][tabindex="0"]');
  expect(comparison?.getAttribute('aria-label')).toBe('Ship comparison');
  expect(comparison?.querySelector('caption')?.textContent).toBe(
    'Starting ship values, before growth or upgrades'
  );
  expect(
    comparison?.querySelector(':scope > [data-slot="table-container"] > table')
  ).not.toBeNull();
  expect(
    [...(comparison?.querySelectorAll('thead th[scope="col"]') ?? [])].map((th) => th.textContent)
  ).toEqual(['Ship', 'Hull', 'Thrust', 'Speed cap', 'Turn °/s', 'Shot interval', 'E cooldown']);
  const rows = [...(comparison?.querySelectorAll('tbody tr') ?? [])].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent)
  );
  expect(rows.map((row) => row.slice(0, 6))).toEqual(
    kits.map((kit) => [
      kit.name,
      `${kit.maxHealth}`,
      `${SHIP.THRUST}`,
      `${SHIP.MAX_VELOCITY}`,
      `${SHIP.TURN_SPEED}`,
      `${kit.shotCooldown} ms`,
    ])
  );
  // The scorecard derives the same cooldown separately; Scout's 20 s is pinned by its ability test.
  expect(rows.map((row) => Number.parseFloat(row[6] ?? ''))).toEqual(
    kits.map((kit) =>
      Number.parseFloat(
        shipRatings(kit.id).find((stat) => stat.label === 'E cooldown')?.display ?? ''
      )
    )
  );
  expect(rows[kits.findIndex((kit) => kit.id === 'scout')]?.[6]).toBe('20 s');
  const topics = [...overview.querySelectorAll('.topic-grid .topic-card')];
  const fieldNotes = articles.filter((entry) => !['scout', 'hauler'].includes(entry.id));
  expect(
    topics.map((card) => [
      card.getAttribute('href'),
      card.querySelector('.card-category')?.textContent,
      card.querySelector('h3')?.textContent,
    ])
  ).toEqual(fieldNotes.map((entry) => [`#${entry.id}`, entry.category, `${entry.title} ↗`]));
});

test('a pilot following a shared link to the Scout entry sees its radar', async () => {
  history.replaceState({}, '', '/wiki/#scout');
  await start();
  expect(document.querySelector('[data-panel="article"]')?.id).toBe('scout');
  expect(charts.mount).toHaveBeenCalledExactlyOnceWith(
    document.querySelector('#scout .ship-radar'),
    'scout'
  );
});

test('searching from a ship entry releases its radar and clearing the search restores one radar', async () => {
  await start();
  await show('#hauler');
  const first = document.querySelector('#hauler .ship-radar');
  expect(charts.mount).toHaveBeenCalledExactlyOnceWith(first, 'hauler');
  const input = document.querySelector<HTMLInputElement>('#wiki-search');
  if (!input) {
    throw new Error('Search input missing');
  }
  input.value = 'tow cable';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(location.hash).toBe('#hauler');
  expect(document.querySelector('.ship-radar')).toBeNull();
  expect(charts.dispose).toHaveBeenCalledTimes(1);
  expect(charts.mount).toHaveBeenCalledTimes(1);
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const restored = document.querySelector('#hauler .ship-radar');
  expect(restored).not.toBe(first);
  expect(charts.mount).toHaveBeenCalledTimes(2);
  expect(charts.mount).toHaveBeenLastCalledWith(restored, 'hauler');
});

test('a pilot opening the Hauler entry sees its rated base stats and where to read next', async () => {
  await start();
  await show('#hauler');
  const entry = document.querySelector('#hauler');
  if (!entry) {
    throw new Error('Hauler entry missing');
  }
  expect(entry.querySelector('.article-title h1')?.textContent).toBe('Hauler');
  expect(entry.querySelector('.article-title img')?.getAttribute('width')).toBe('80');
  expect(entry.querySelector('.ship-ability-name')?.textContent).toContain(
    getShipKit('hauler').abilityName
  );
  expect(
    [...entry.querySelectorAll('.ship-stat')].map((stat) => ({
      label: stat.querySelector('dt')?.textContent,
      value: stat.querySelector('.ship-stat-value')?.textContent,
      rating: stat.querySelector('.stat-bubbles')?.getAttribute('aria-label'),
      filled: stat.querySelectorAll('.stat-bubble.filled').length,
      bubbles: stat.querySelectorAll('.stat-bubble').length,
    }))
  ).toEqual(
    shipRatings('hauler').map((stat) => ({
      label: stat.label,
      value: stat.display,
      rating: `${stat.rating} out of 5`,
      filled: stat.rating,
      bubbles: 5,
    }))
  );
  const hauler = articles.find((article) => article.id === 'hauler');
  expect(
    [...entry.querySelectorAll('.related-link')].map((link) => [
      link.getAttribute('href'),
      link.textContent,
    ])
  ).toEqual(
    hauler?.related.map((id) => [`#${id}`, articles.find((article) => article.id === id)?.title])
  );
});

test('entry titles, categories and summaries render as text rather than markup', async () => {
  const controls = articles.find((article) => article.id === 'controls');
  if (!controls) {
    throw new Error('Controls entry missing');
  }
  const manifest: WikiArticle = {
    ...controls,
    id: 'cargo-manifest',
    title: '<img src=x onerror="alert(1)"> Tow & Tether',
    category: 'Logistics <b>bulk</b>',
    summary: 'Cables <script>window.hijacked = true</script> & cargo',
    order: 999,
    html: '<p>Manifest notes for Hauler crews.</p>',
    searchText: 'cargo manifest tow tether',
    sections: [],
    related: ['controls'],
    media: [],
  };
  const withManifest = [
    ...articles.map((article) =>
      article.id === 'controls'
        ? { ...article, related: [...article.related, manifest.id] }
        : article
    ),
    manifest,
  ];
  shell = mount(WikiShell, { target: document.body, props: { articles: withManifest } });
  await settle();
  const card = document.querySelector('.topic-card[href="#cargo-manifest"]');
  expect(card?.querySelector('.card-category')?.textContent).toBe(manifest.category);
  expect(card?.querySelector('h3')?.textContent).toBe(`${manifest.title} ↗`);
  expect(card?.querySelector('p')?.textContent).toBe(manifest.summary);
  await show('#cargo-manifest');
  expect(document.querySelector('#cargo-manifest h1')?.textContent).toBe(manifest.title);
  expect(document.querySelector('#cargo-manifest .breadcrumb')?.textContent).toContain(
    manifest.category
  );
  expect(document.title).toBe(`${manifest.title} | GeoRoids field manual`);
  await show('#controls');
  expect(
    document.querySelector('#controls .related-link[href="#cargo-manifest"]')?.textContent
  ).toBe(manifest.title);
  expect(document.body.querySelector('img[src="x"], b, script')).toBeNull();
});

test('Back restores the visit offset and a remounted manual restores the saved reload offset', async () => {
  await start();
  await show('#controls');
  scrollY = 420;
  window.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(500);
  const controlsState: unknown = history.state;
  await show('#hauler');
  scrollY = 90;
  history.replaceState(controlsState, '', '/wiki/#controls');
  window.dispatchEvent(new PopStateEvent('popstate', { state: controlsState }));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await settle();
  expect(scrollY).toBe(420);
  expect(document.querySelector('[data-panel="article"]')?.id).toBe('controls');
  if (!shell) {
    throw new Error('Manual is not mounted');
  }
  await unmount(shell);
  shell = undefined;
  scrollY = 0;
  await start();
  expect(scrollY).toBe(420);
});

test('a reader requesting reduced motion sees demonstration posters', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  await start();
  await show('#hauler');
  expect(document.querySelector<HTMLImageElement>('.demo img')?.getAttribute('src')).toBe(
    '/wiki/media/hauler.png'
  );
});

test('mobile readers expand the manual navigation and it closes after choosing a topic', async () => {
  vi.stubGlobal('innerWidth', 390);
  shell = mount(WikiShell, { target: document.body, props: { articles } });
  const navigation = document.querySelector<HTMLDetailsElement>('#navigation');
  if (!navigation) {
    throw new Error('Manual navigation missing');
  }
  // The first render must be collapsed before mount effects choose a viewport layout.
  expect(navigation.open).toBe(false);
  await settle();
  expect(navigation.open).toBe(false);
  navigation.open = true;
  navigation.dispatchEvent(new Event('toggle'));
  await settle();
  expect(navigation.querySelector('a[href="#controls"]')).not.toBeNull();
  await show('#controls');
  expect(navigation.open).toBe(false);
  expect(document.querySelector('[data-panel="article"]')?.id).toBe('controls');
});

test('desktop readers see expanded navigation after the manual mounts', async () => {
  vi.stubGlobal('innerWidth', 1280);
  await start();
  expect(document.querySelector<HTMLDetailsElement>('#navigation')?.open).toBe(true);
});

test('blocked history writes report once while in-memory scroll restoration remains usable', async () => {
  const failure = new DOMException('History writes blocked', 'SecurityError');
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const replace = vi.spyOn(history, 'replaceState').mockImplementation(() => {
    throw failure;
  });
  await start();
  expect(document.querySelector('[data-panel="overview"]')).not.toBeNull();
  vi.runOnlyPendingTimers();
  scrollY = 320;
  window.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(500);
  expect(replace.mock.calls.length).toBeGreaterThan(1);
  expect(report).toHaveBeenCalledExactlyOnceWith(
    '[WIKI] Saving scroll history failed; retaining it in memory for this visit',
    expect.objectContaining({ name: 'SecurityError', message: 'History writes blocked' })
  );

  const input = document.querySelector<HTMLInputElement>('#wiki-search');
  if (!input) {
    throw new Error('Search input missing');
  }
  input.value = 'hauler';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(document.querySelector('[data-panel="search"]')).not.toBeNull();
  scrollY = 0;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(document.querySelector('[data-panel="overview"]')).not.toBeNull();
  await vi.waitFor(() => expect(scrollY).toBe(320));
  expect(report).toHaveBeenCalledOnce();
});
