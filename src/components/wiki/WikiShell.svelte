<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isShipKitId } from '../../entities/ship/shipKits';
  import type { WikiArticle } from '../../wiki/article';
  import { setMediaSource, shouldAutoplayMedia } from '../../wiki/mediaPlayback';
  import { articleHtml, overviewHtml } from '../../wiki/presentation';
  import { WikiScrollMemory } from '../../wiki/scrollMemory';
  import { searchArticles } from '../../wiki/search';
  import { mountShipRadar } from '../../wiki/shipScorecard';
  import Button from '../ui/button/button.svelte';
  import Input from '../ui/input/input.svelte';

  let { articles }: { articles: WikiArticle[] } = $props();
  let initialized = $state(false);
  let route = $state('content');
  let query = $state('');
  let navigationOpen = $state(true);
  let content: HTMLElement;
  let searchInput = $state<HTMLInputElement | null>(null);
  const categories = $derived([...new Set(articles.map((entry) => entry.category))]);
  const results = $derived(searchArticles(articles, query.trim()));
  const article = $derived(articles.find((entry) => entry.id === route));
  const overview = $derived(!route || route === 'content' || route === 'ships');
  let memory: WikiScrollMemory | undefined;
  let searchHeld = false;
  let alive = true;
  let generation = 0;
  let frame: number | undefined;
  let disposeRadar = () => {};

  function savedScroll(state: unknown): { id?: string; y?: number } {
    if (!state || typeof state !== 'object') {
      return {};
    }
    const record = state as Record<string, unknown>;
    return {
      ...(typeof record['wikiScrollId'] === 'string' ? { id: record['wikiScrollId'] } : {}),
      ...(typeof record['wikiScrollY'] === 'number' &&
      Number.isFinite(record['wikiScrollY']) &&
      record['wikiScrollY'] >= 0
        ? { y: record['wikiScrollY'] }
        : {}),
    };
  }
  function writeScroll(y: number) {
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
    }
    window.scrollTo(0, y);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      window.scrollTo(0, y);
    });
  }
  function remember(id: string, y: number) {
    const previous = history.state && typeof history.state === 'object' ? history.state : {};
    try {
      history.replaceState({ ...previous, wikiScrollId: id, wikiScrollY: y }, '');
    } catch {
      /* In-memory history remains available when the browser throttles writes. */
    }
  }
  function routeKey() {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return 'invalid-link';
    }
  }
  function playback() {
    if (!initialized) {
      return;
    }
    const playing = shouldAutoplayMedia(
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      document.hidden
    );
    for (const figure of content.querySelectorAll<HTMLElement>('.demo')) {
      const image = figure.querySelector('img');
      const id = figure.dataset['media'];
      if (image && id) {
        setMediaSource(image, id, playing);
      }
    }
  }
  async function activate(moveFocus: boolean) {
    const ticket = ++generation;
    disposeRadar();
    disposeRadar = () => {};
    await tick();
    if (!alive || ticket !== generation) {
      return;
    }
    document.title = query.trim()
      ? 'Search | GeoRoids field manual'
      : article
        ? `${article.title} | GeoRoids field manual`
        : overview
          ? 'Field manual | GeoRoids'
          : 'Entry not found | GeoRoids field manual';
    if (article && !query.trim()) {
      if (article.media.length !== content.querySelectorAll('.demo').length) {
        throw new Error(`Media mapping mismatch for ${article.id}`);
      }
      const radar = content.querySelector<HTMLElement>('.ship-radar');
      if (radar && isShipKitId(article.id)) {
        disposeRadar = mountShipRadar(radar, article.id);
      }
      playback();
    }
    if (moveFocus) {
      content.focus({ preventScroll: true });
      memory?.show(
        () => crypto.randomUUID(),
        () => {
          if (route === 'ships') {
            content.querySelector('#ships')?.scrollIntoView();
          } else {
            writeScroll(0);
          }
        }
      );
    }
  }
  function navigate() {
    query = '';
    searchHeld = false;
    route = routeKey();
    if (window.innerWidth < 800) {
      navigationOpen = false;
    }
    void activate(true);
  }
  function searchChanged(value: string) {
    if (value.trim() && !searchHeld) {
      memory?.hold(window.scrollY);
      searchHeld = true;
    }
    query = value;
    void activate(false).then(() => {
      if (query === value && !value.trim() && searchHeld) {
        searchHeld = false;
        memory?.release();
      }
    });
  }
  function clearSearch() {
    searchChanged('');
    searchInput?.focus();
  }
  function linkClick(event: MouseEvent) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const anchor = event.target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }
    if (anchor.classList.contains('skip-link')) {
      event.preventDefault();
      content.focus();
      content.scrollIntoView();
      return;
    }
    const href = anchor.getAttribute('href');
    if (!href) {
      return;
    }
    if (!href.startsWith('#')) {
      memory?.prepareForDocumentLeave(window.scrollY);
      return;
    }
    if (href === (window.location.hash || '#')) {
      event.preventDefault();
      navigate();
    } else {
      memory?.prepareForLink(window.scrollY);
    }
  }
  onMount(() => {
    alive = true;
    const initial = savedScroll(history.state);
    const id = initial.id ?? crypto.randomUUID();
    const oldRestoration = history.scrollRestoration;
    memory = new WikiScrollMemory(id, writeScroll, remember, () => window.scrollY);
    if (!initial.id) {
      remember(id, initial.y ?? 0);
    }
    history.scrollRestoration = 'manual';
    initialized = true;
    route = routeKey();
    navigationOpen = window.innerWidth >= 800;
    void activate(false).then(() => {
      if (!alive) {
        return;
      }
      if (initial.y !== undefined) {
        memory?.restoreSaved(initial.y);
      } else if (route === 'ships') {
        content.querySelector('#ships')?.scrollIntoView();
      } else {
        writeScroll(0);
      }
    });
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotion.addEventListener('change', playback);
    return () => {
      alive = false;
      generation++;
      disposeRadar();
      memory?.capture(window.scrollY);
      memory?.dispose();
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      reduceMotion.removeEventListener('change', playback);
      history.scrollRestoration = oldRestoration;
    };
  });
</script>

<svelte:window
  onhashchange={navigate}
  onscroll={() => memory?.noteScroll(window.scrollY)}
  onpopstate={(event) => {
    const saved = savedScroll(event.state);
    memory?.prepareForTraversal(saved.id, saved.y, window.scrollY);
  }}
  onpagehide={() => memory?.capture(window.scrollY)}
  onpageshow={(event) => {
    const y = savedScroll(history.state).y;
    if (event.persisted && y !== undefined) memory?.restoreSaved(y);
  }}
/>
<svelte:document onclickcapture={linkClick} onvisibilitychange={playback} />

<div class="wiki-shell">
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="/">△ GEOROIDS</a><a href="#content">Field manual</a><Button
      class="min-h-11"
      href="/"
      variant="outline">Play GeoRoids ↗</Button
    >
  </header>
  <div class="layout">
    <aside class="sidebar" aria-label="Manual navigation">
      <search
        ><form
          id="search-form"
          onsubmit={(event) => {
            event.preventDefault();
            content.focus();
          }}
        >
          <label for="wiki-search">Find a mechanic</label>
          <div class="search-box">
            <Input
              class="min-h-11"
              id="wiki-search"
              type="search"
              placeholder="Ship, skill, interaction…"
              autocomplete="off"
              aria-controls="content"
              bind:ref={searchInput}
              value={query}
              oninput={(event) => searchChanged(event.currentTarget.value)}
            /><Button
              class="min-h-11"
              id="clear-search"
              type="button"
              variant="ghost"
              aria-label="Clear search"
              hidden={!query}
              onclick={clearSearch}>×</Button
            >
          </div>
        </form></search
      >
      <details id="navigation" bind:open={navigationOpen}>
        <summary>Browse the manual</summary>
        <nav id="article-nav" aria-label="Topics">
          <a href="#content" aria-current={overview && !query.trim() ? 'page' : undefined}
            >Overview</a
          >
          {#each categories as category (category)}<section>
              <h2>{category}</h2>
              {#each articles.filter((entry) => entry.category === category) as entry (entry.id)}<a
                  href={`#${entry.id}`}
                  aria-current={entry.id === route && !query.trim() ? 'page' : undefined}
                  >{entry.title}</a
                >{/each}
            </section>{/each}
        </nav>
      </details>
    </aside>
    <main id="content" tabindex="-1" bind:this={content}>
      {#if !initialized || (!query.trim() && overview)}<div data-panel="overview">
          {@html overviewHtml(articles)}
        </div>{/if}
      {#each articles as entry (entry.id)}{#if !initialized || (!query.trim() && route === entry.id)}<section
            id={entry.id}
            data-panel="article"
          >
            {@html articleHtml(entry, articles)}
          </section>{/if}{/each}
      {#if initialized && query.trim()}<section class="search-results" data-panel="search">
          <p class="eyebrow">Search the manual</p>
          <h1>Results for “{query.trim()}”</h1>
          <p>{results.length} {results.length === 1 ? 'entry' : 'entries'} found</p>
          <div class="topic-grid">
            {#each results as entry (entry.id)}<a class="topic-card" href={`#${entry.id}`}
                ><span>{entry.category}</span>
                <h2>{entry.title}</h2>
                <p>{entry.summary}</p></a
              >{/each}
          </div>
          {#if !results.length}<h2>No matching entries</h2>
            <p>Try a ship name, “furnace”, “minerals”, or “asteroid”.</p>
            <Button class="min-h-11" onclick={clearSearch}>Show all topics</Button>{/if}
        </section>{/if}
      {#if initialized && !query.trim() && !overview && !article}<section data-panel="not-found">
          <p class="eyebrow">Unknown entry</p>
          <h1>That entry is not in the manual.</h1>
          <p>Browse the index or search for a mechanic.</p>
          <a href="#content">Back to the field manual →</a>
        </section>{/if}
    </main>
  </div>
  <footer class="site-footer">
    <span>GeoRoids / Field manual</span><a href="#content">Back to index ↑</a>
  </footer>
  <p id="search-status" class="sr-only" role="status" aria-live="polite">
    {query.trim() ? `${results.length} matching entries` : ''}
  </p>
</div>

<style>
  .wiki-shell {
    color: var(--foreground);
    background: var(--background);
    min-height: 100dvh;
    font-family: system-ui, sans-serif;
  }
  .site-header,
  .site-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem max(1rem, env(safe-area-inset-left));
    border-bottom: 1px solid var(--border);
  }
  .site-header > a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.1em;
  }
  .layout {
    display: grid;
    grid-template-columns: 15rem minmax(0, 1fr);
    gap: 3rem;
    max-width: 80rem;
    margin: auto;
    padding: 2rem;
  }
  .sidebar {
    align-self: start;
    position: sticky;
    top: 1rem;
  }
  .search-box {
    display: flex;
    gap: 0.25rem;
    margin: 0.5rem 0 1rem;
  }
  nav a {
    display: block;
    min-height: 44px;
    padding: 0.75rem;
    border-radius: 0.375rem;
  }
  nav a[aria-current] {
    background: var(--accent);
    color: var(--accent-foreground);
  }
  nav h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--muted-foreground);
    margin: 1rem 0.75rem 0.25rem;
  }
  summary {
    cursor: pointer;
    min-height: 44px;
    padding: 0.75rem 0;
  }
  main {
    min-width: 0;
  }
  main :global(h1) {
    font-size: clamp(2rem, 5vw, 3.5rem);
    font-weight: 700;
    letter-spacing: -0.04em;
    margin: 1rem 0;
    line-height: 1.1;
  }
  main :global(h2) {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 1.5rem 0 0.75rem;
  }
  main :global(h3) {
    font-weight: 600;
    margin: 0.75rem 0;
  }
  main :global(p) {
    margin: 0.75rem 0;
    line-height: 1.7;
  }
  main :global(a) {
    text-underline-offset: 4px;
  }
  main :global(.article-body a) {
    text-decoration: underline;
  }
  main :global(a:hover) {
    text-decoration: underline;
  }
  main :global(.eyebrow),
  main :global(.card-category) {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted-foreground);
  }
  main :global(.topic-grid),
  main :global(.ship-grid) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 1rem;
    margin: 1.5rem 0;
  }
  main :global(.topic-card),
  main :global(.ship-card) {
    display: block;
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--card);
  }
  main :global(.hero),
  main :global(.section-block),
  main :global(article) {
    margin-bottom: 3rem;
  }
  main :global(.hero-orbit) {
    display: none;
  }
  main :global(.hero-links),
  main :global(.related > div),
  main :global(.breadcrumb) {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }
  main :global(.article-title) {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  main :global(.table-scroll) {
    overflow: auto;
  }
  main :global(table) {
    width: 100%;
    border-collapse: collapse;
  }
  main :global(th),
  main :global(td) {
    text-align: left;
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  main :global(.demo img) {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
  }
  main :global(.topic-demo-card),
  main :global(.ship-scorecard) {
    padding: 1.5rem;
    margin: 1.5rem 0;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
  }
  main :global(.ship-profile-layout) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  main :global(.ship-radar) {
    height: 260px;
    min-width: 0;
  }
  main :global(.ship-ability-name) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  main :global(.ship-stat) {
    display: flex;
    justify-content: space-between;
    padding: 0.5rem 0;
  }
  main :global(.stat-bubbles) {
    display: inline-flex;
    gap: 3px;
    margin-left: 0.5rem;
  }
  main :global(.stat-bubble) {
    width: 6px;
    height: 6px;
    border-radius: 100%;
    background: var(--muted);
  }
  main :global(.stat-bubble.filled) {
    background: var(--foreground);
  }
  .skip-link {
    position: absolute;
    left: 1rem;
    top: -10rem;
  }
  .skip-link:focus {
    top: 1rem;
    z-index: 10;
    background: var(--background);
    padding: 1rem;
  }
  @media (max-width: 799px) {
    .layout {
      grid-template-columns: 1fr;
      gap: 1rem;
      padding: 1rem;
    }
    .sidebar {
      position: static;
    }
    main :global(.ship-profile-layout) {
      grid-template-columns: 1fr;
    }
    .site-header {
      flex-wrap: wrap;
    }
  }
</style>
