import { GAME } from '../constants';
import { serializeKitHullSvg } from '../entities/ship/hullOutlines';
import { isShipKitId, listShipKits, SHIP_ABILITY } from '../entities/ship/shipKits';
import { articles, type WikiArticle } from './content';
import { media } from './media';
import { searchArticles } from './search';

function requiredElement<T extends HTMLElement>(
  selector: string,
  elementClass: new (...args: never[]) => T
): T {
  const element = document.querySelector(selector);
  if (!(element instanceof elementClass)) {
    throw new Error(`Missing wiki element: ${selector}`);
  }
  return element;
}

const content = requiredElement('#content', HTMLElement);
const search = requiredElement('#wiki-search', HTMLInputElement);
const clearSearch = requiredElement('#clear-search', HTMLButtonElement);
const navigation = requiredElement('#navigation', HTMLDetailsElement);
const status = requiredElement('#search-status', HTMLElement);
const nav = requiredElement('#article-nav', HTMLElement);
const categories = [...new Set(articles.map((article) => article.category))];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  );
}

function hull(id: string, size = 64): string {
  return isShipKitId(id)
    ? `<span aria-hidden="true">${serializeKitHullSvg(id, { background: false, title: false, width: size, height: size })}</span>`
    : '';
}

function articleLink(article: WikiArticle, className = ''): string {
  return `<a class="${className}" href="#${article.id}">${escapeHtml(article.title)}</a>`;
}

function card(article: WikiArticle): string {
  return `<a class="topic-card" href="#${article.id}"><span class="card-category">${escapeHtml(article.category)}</span><h3>${escapeHtml(article.title)} <span aria-hidden="true">↗</span></h3><p>${escapeHtml(article.summary)}</p></a>`;
}

function renderNavigation(active = ''): void {
  nav.innerHTML = `<a class="index-link" href="#content" ${active === '' ? 'aria-current="page"' : ''}>Overview</a>${categories
    .map(
      (category) =>
        `<section><h2>${escapeHtml(category)}</h2>${articles
          .filter((article) => article.category === category)
          .map(
            (article) =>
              `<a href="#${article.id}" ${active === article.id ? 'aria-current="page"' : ''}>${escapeHtml(article.title)}</a>`
          )
          .join('')}</section>`
    )
    .join('')}`;
}

function renderIndex(): void {
  const kits = listShipKits();
  content.innerHTML = `<section class="hero"><p class="eyebrow">THE PILOT'S REFERENCE</p><h1>Know your ship.<br /><span>Read the arena.</span></h1><p class="hero-copy">Five ships. A shared, unpredictable arena. Learn what everything does, see it in motion, then take it into flight.</p><div class="hero-links"><a href="#controls" class="primary-link">Start with the controls <span aria-hidden="true">→</span></a><a href="#ships">Compare ships ↓</a></div><div class="hero-orbit" aria-hidden="true">${hull('hauler', 120)}<span class="orbit-dot"></span></div></section>
  <section class="section-block" id="ships"><div class="section-heading"><div><p class="eyebrow">01 / HANGAR</p><h2>Choose your ship</h2></div><span>One ability. A different way to fly.</span></div><div class="ship-grid">${kits.map((kit, index) => `<a class="ship-card" href="#${kit.id}"><span class="ship-number">0${index + 1}</span>${hull(kit.id, 82)}<h3>${escapeHtml(kit.name)}</h3><p>${escapeHtml(kit.abilityName)}</p><span class="ship-health">${kit.maxHealth} HULL <span aria-hidden="true">↗</span></span></a>`).join('')}</div><details class="comparison"><summary>Compare hull, handling, and ability cooldowns</summary><div class="table-scroll" role="region" aria-label="Ship comparison" tabindex="0"><table><caption>Starting ship values, before growth or upgrades</caption><thead><tr><th scope="col">Ship</th><th scope="col">Hull</th><th scope="col">Thrust</th><th scope="col">Speed cap</th><th scope="col">Turn °/s</th><th scope="col">Shot interval</th><th scope="col">E cooldown</th></tr></thead><tbody>${kits.map((kit) => `<tr><th scope="row"><a href="#${kit.id}">${kit.name}</a></th><td>${kit.maxHealth}</td><td>${kit.thrust}</td><td>${kit.maxVelocity}</td><td>${kit.turnSpeed}</td><td>${kit.shotCooldown} ms</td><td>${SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] / GAME.FPS} s</td></tr>`).join('')}</tbody></table></div><p>Thrust and speed cap are game tuning values for comparison, not screen pixels per second. Abilities, terrain, and tether motion can alter movement.</p></details></section>
  <section class="section-block"><div class="section-heading"><div><p class="eyebrow">02 / FIELD NOTES</p><h2>Understand the arena</h2></div><span>Rules, controls, and interactions.</span></div><div class="topic-grid">${articles
    .filter((article) => !isShipKitId(article.id))
    .map(card)
    .join('')}</div></section>`;
  document.title = 'Field manual | GeoRoids';
}

function figure(id: string): string {
  const item = media[id];
  if (!item) {
    return '';
  }
  return `<figure class="demo" data-media="${id}"><div class="demo-heading"><span>IN MOTION</span><button type="button" class="media-toggle" aria-pressed="false" aria-label="Play ${escapeHtml(item.title)} animation">Play animation <span aria-hidden="true">▷</span></button></div><img src="/wiki/media/${id}.png" width="640" height="360" loading="lazy" alt="${escapeHtml(item.alt)}" /><figcaption><strong>${escapeHtml(item.title)}</strong> ${escapeHtml(item.caption)}</figcaption></figure>`;
}

function renderArticle(article: WikiArticle): void {
  content.innerHTML = `<div class="breadcrumb"><a href="#content">Field manual</a><span aria-hidden="true">/</span><span>${escapeHtml(article.category)}</span></div><article><header class="article-header"><p class="eyebrow">${escapeHtml(article.category)}</p><div class="article-title">${hull(article.id, 80)}<h1>${escapeHtml(article.title)}</h1></div><p class="article-summary">${escapeHtml(article.summary)}</p></header>${article.media.slice(0, 1).map(figure).join('')}<div class="article-body">${article.sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}</section>`).join('')}</div>${article.media.slice(1).map(figure).join('')}<aside class="related"><p class="eyebrow">KEEP EXPLORING</p><h2>Related entries</h2><div>${article.related
    .map((id) => articles.find((item) => item.id === id))
    .filter((item): item is WikiArticle => item !== undefined)
    .map((item) => articleLink(item, 'related-link'))
    .join('')}</div></aside></article>`;
  document.title = `${article.title} | GeoRoids field manual`;
}

function stopAnimations(): void {
  content
    .querySelectorAll<HTMLButtonElement>('.media-toggle[aria-pressed="true"]')
    .forEach((button) => {
      button.click();
    });
}

content.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest('button.media-toggle');
  const figureElement = button?.closest('figure');
  const image = figureElement?.querySelector('img');
  const id = figureElement?.dataset['media'];
  if (!button || !image || !id) {
    return;
  }
  const playing = button.getAttribute('aria-pressed') !== 'true';
  image.src = `/wiki/media/${id}.${playing ? 'gif' : 'png'}`;
  button.setAttribute('aria-pressed', String(playing));
  button.setAttribute(
    'aria-label',
    `${playing ? 'Pause' : 'Play'} ${media[id]?.title ?? ''} animation`
  );
  button.textContent = playing ? 'Pause animation Ⅱ' : 'Play animation ▷';
});
reduceMotion.addEventListener('change', () => {
  if (reduceMotion.matches) {
    stopAnimations();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAnimations();
  }
});

function renderSearch(): void {
  clearSearch.hidden = search.value.length === 0;
  const query = search.value.trim();
  if (!query) {
    renderRoute(false);
    return;
  }
  const results = searchArticles(articles, query);
  content.innerHTML = `<section class="search-results"><p class="eyebrow">SEARCH THE MANUAL</p><h1>Results for “${escapeHtml(query)}”</h1><p>${results.length} ${results.length === 1 ? 'entry' : 'entries'} found</p>${results.length ? `<div class="topic-grid">${results.map(card).join('')}</div>` : '<div class="empty-state"><h2>No matching entries</h2><p>Try a ship name, “shield”, “fuel”, or “asteroid”.</p><button type="button" id="reset-results">Show all topics</button></div>'}</section>`;
  status.textContent = `${results.length} matching entries`;
  document.title = 'Search | GeoRoids field manual';
  content.querySelector('#reset-results')?.addEventListener('click', resetSearch);
}

function resetSearch(): void {
  search.value = '';
  clearSearch.hidden = true;
  renderRoute(false);
  search.focus();
}

function renderRoute(moveFocus = true): void {
  status.textContent = '';
  let id = '';
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    id = 'invalid-link';
  }
  const article = articles.find((item) => item.id === id);
  const isIndex = !id || id === 'ships' || id === 'content';
  renderNavigation(isIndex ? '' : id);
  if (article) {
    renderArticle(article);
  } else if (isIndex) {
    renderIndex();
  } else {
    content.innerHTML =
      '<section class="search-results"><p class="eyebrow">UNKNOWN ENTRY</p><h1>That entry is not in the manual.</h1><p>Browse the index or search for a mechanic.</p><a href="#content" class="primary-link">Back to the field manual →</a></section>';
    document.title = 'Entry not found | GeoRoids field manual';
  }
  if (moveFocus) {
    content.focus({ preventScroll: true });
    if (id === 'ships') {
      content.querySelector('#ships')?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }
}
search.addEventListener('input', renderSearch);
clearSearch.addEventListener('click', resetSearch);
requiredElement('#search-form', HTMLFormElement).addEventListener('submit', (event) => {
  event.preventDefault();
  content.focus();
});
window.addEventListener('hashchange', () => {
  search.value = '';
  clearSearch.hidden = true;
  if (window.innerWidth < 800) {
    navigation.open = false;
  }
  renderRoute();
});
document.addEventListener('click', (event) => {
  if (
    !(event.target instanceof Element) ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
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
  if (!href?.startsWith('#') || href !== (window.location.hash || '#')) {
    return;
  }
  event.preventDefault();
  search.value = '';
  clearSearch.hidden = true;
  renderRoute();
});
if (window.innerWidth < 800) {
  navigation.open = false;
}
renderRoute(false);
