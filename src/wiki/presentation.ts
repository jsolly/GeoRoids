import { GAME } from '../constants';
import { serializeKitHullSvg } from '../entities/ship/hullOutlines';
import { isShipKitId, listShipKits, SHIP_ABILITY } from '../entities/ship/shipKits';
import type { WikiArticle } from './article';
import { shipScorecard } from './shipScorecard';

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/gu,
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

export function overviewHtml(articles: WikiArticle[]): string {
  const kits = listShipKits();
  return `<section class="hero"><p class="eyebrow">THE PILOT'S REFERENCE</p><h1>Know your ship.<br /><span>Read the arena.</span></h1><p class="hero-copy">Scout and Hauler. A shared, unpredictable arena. Learn what everything does, see it in motion, then take it into flight.</p><div class="hero-links"><a href="#controls" class="primary-link">Start with the controls <span aria-hidden="true">→</span></a><a href="#ships">Compare ships ↓</a></div><div class="hero-orbit" aria-hidden="true">${hull('hauler', 120)}<span class="orbit-dot"></span></div></section>
  <section class="section-block" id="ships"><div class="section-heading"><div><p class="eyebrow">01 / HANGAR</p><h2>Choose your ship</h2></div><span>One ability. A different way to fly.</span></div><div class="ship-grid">${kits.map((kit, index) => `<a class="ship-card" href="#${kit.id}"><span class="ship-number">0${index + 1}</span>${hull(kit.id, 82)}<h3>${escapeHtml(kit.name)}</h3><p>${escapeHtml(kit.abilityName)}</p><span class="ship-health">${kit.maxHealth} HULL <span aria-hidden="true">↗</span></span></a>`).join('')}</div><details class="comparison"><summary>Compare hull, handling, and ability cooldowns</summary><div class="table-scroll" role="region" aria-label="Ship comparison" tabindex="0"><table><caption>Starting ship values, before growth or upgrades</caption><thead><tr><th scope="col">Ship</th><th scope="col">Hull</th><th scope="col">Thrust</th><th scope="col">Speed cap</th><th scope="col">Turn °/s</th><th scope="col">Shot interval</th><th scope="col">E cooldown</th></tr></thead><tbody>${kits.map((kit) => `<tr><th scope="row"><a href="#${kit.id}">${kit.name}</a></th><td>${kit.maxHealth}</td><td>${kit.thrust}</td><td>${kit.maxVelocity}</td><td>${kit.turnSpeed}</td><td>${kit.shotCooldown} ms</td><td>${SHIP_ABILITY.COOLDOWN_FRAMES[kit.id] / GAME.FPS} s</td></tr>`).join('')}</tbody></table></div><p>Thrust and speed cap are game tuning values for comparison, not screen pixels per second. Boost, abilities, and terrain can alter movement.</p></details></section>
  <section class="section-block"><div class="section-heading"><div><p class="eyebrow">02 / FIELD NOTES</p><h2>Understand the arena</h2></div><span>Rules, controls, and interactions.</span></div><div class="topic-grid">${articles
    .filter((article) => !isShipKitId(article.id))
    .map(card)
    .join('')}</div></section>`;
}

export function articleHtml(article: WikiArticle, articles: WikiArticle[]): string {
  return `<div class="breadcrumb"><a href="#content">Field manual</a><span aria-hidden="true">/</span><span>${escapeHtml(article.category)}</span></div><article><header class="article-header"><p class="eyebrow">${escapeHtml(article.category)}</p><div class="article-title">${hull(article.id, 80)}<h1>${escapeHtml(article.title)}</h1></div><p class="article-summary">${escapeHtml(article.summary)}</p></header>${isShipKitId(article.id) ? shipScorecard(article.id) : ''}<div class="article-body">${article.html}</div><aside class="related"><p class="eyebrow">KEEP EXPLORING</p><h2>Related entries</h2><div>${article.related
    .map((id) => articles.find((item) => item.id === id))
    .filter((item): item is WikiArticle => item !== undefined)
    .map((item) => articleLink(item, 'related-link'))
    .join('')}</div></aside></article>`;
}
