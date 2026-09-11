import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { parse } from 'yaml';
import { isShipKitId } from '../src/entities/ship/shipKits';
import type { WikiArticle } from '../src/wiki/article';
import articleSources from '../src/wiki/articleSources.json';
import { gameReference } from '../src/wiki/gameReference';
import { media } from '../src/wiki/media';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
type Token = ReturnType<typeof markdown.parse>[number];
markdown.renderer.rules['table_open'] = () =>
  '<div class="table-scroll" role="region" aria-label="Article table" tabindex="0"><table>';
markdown.renderer.rules['table_close'] = () => '</table></div>';
const categories = new Set(['Start here', 'Ships', 'Systems', 'Arena', 'Combat']);
const reservedIds = new Set(['content', 'ships']);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be nonempty text`);
  }
  return value.trim();
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a list of text values`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${field} contains duplicates`);
  }
  return value;
}

function walk(tokens: Token[]): Token[] {
  return tokens.flatMap((token) => [token, ...walk(token.children ?? [])]);
}

/** Compile trusted application code and untrusted editorial files at one boundary. */
export function readWikiArticles(root = process.cwd()): WikiArticle[] {
  const directory = resolve(root, 'content/wiki');
  const entries = readdirSync(directory, { withFileTypes: true });
  const drafts = entries.map((entry) => {
    if (!entry.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(entry.name)) {
      throw new Error(`Wiki articles must be flat Markdown files with stable slugs: ${entry.name}`);
    }
    const id = entry.name.slice(0, -3);
    if (reservedIds.has(id)) {
      throw new Error(`Reserved wiki ID: ${id}`);
    }
    const raw = readFileSync(resolve(directory, entry.name), 'utf8').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!match) {
      throw new Error(`${id}: expected YAML frontmatter and Markdown body`);
    }
    const data: unknown = parse(match[1] ?? '');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`${id}: invalid frontmatter`);
    }
    const get = (key: string): unknown => Reflect.get(data, key);
    const title = text(get('title'), `${id}.title`);
    const category = text(get('category'), `${id}.category`);
    if (!categories.has(category)) {
      throw new Error(`${id}: unknown category ${category}`);
    }
    const summary = text(get('summary'), `${id}.summary`);
    const order = get('order');
    if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) {
      throw new Error(`${id}.order must be a nonnegative integer`);
    }
    const body = text(match[2], `${id}.body`);
    const related = strings(get('related'), `${id}.related`).map((path) => {
      const reference = /^content\/wiki\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(path);
      if (!reference?.[1]) {
        throw new Error(`${id}: invalid related article path ${path}`);
      }
      return reference[1];
    });
    const placements: unknown = get('media') ?? [];
    if (!Array.isArray(placements)) {
      throw new Error(`${id}.media must be a list of demonstration placements`);
    }
    const byHeading = new Map<string, string>();
    const selected = new Set<string>();
    for (const placement of placements) {
      if (!placement || typeof placement !== 'object' || Array.isArray(placement)) {
        throw new Error(`${id}: each demonstration needs a demo and section heading`);
      }
      const name = text(Reflect.get(placement, 'demo'), `${id}.media.demo`);
      const heading = text(Reflect.get(placement, 'heading'), `${id}.media.heading`);
      if (!Object.hasOwn(media, name)) {
        throw new Error(`${id}: unknown demonstration ${name}`);
      }
      if (byHeading.has(heading) || selected.has(name)) {
        throw new Error(`${id}: duplicate demonstration or section placement`);
      }
      byHeading.set(heading, name);
      selected.add(name);
    }
    const tokens = markdown.parse(body, {});
    const flattened = walk(tokens);
    if (flattened.some((token) => token.type === 'heading_open' && token.tag === 'h1')) {
      throw new Error(`${id}: use Heading 2 or below; the title is already Heading 1`);
    }
    const groups: { heading?: string; tokens: Token[] }[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!token) {
        continue;
      }
      if (token.type === 'heading_open' && token.tag === 'h2' && token.level === 0) {
        const heading = tokens[index + 1]?.children
          ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
          .map((child) => child.content)
          .join('');
        groups.push({ heading: heading ?? '', tokens: [] });
      }
      if (!groups.length) {
        groups.push({ tokens: [] });
      }
      groups[groups.length - 1]?.tokens.push(token);
    }
    for (const heading of byHeading.keys()) {
      if (groups.filter((group) => group.heading === heading).length !== 1) {
        throw new Error(
          `${id}: demonstration heading must match exactly one Heading 2: ${heading}`
        );
      }
    }
    const demonstrations: string[] = [];
    const bodyHtml = groups
      .map((group, index) => {
        const headingId = `${id}-section-${index}`;
        if (group.heading) {
          group.tokens[0]?.attrSet('id', headingId);
        }
        const html = markdown.renderer.render(group.tokens, markdown.options, {});
        const name = group.heading ? byHeading.get(group.heading) : undefined;
        if (!name) {
          return group.heading ? `<section aria-labelledby="${headingId}">${html}</section>` : html;
        }
        demonstrations.push(name);
        const item = media[name];
        if (!item) {
          throw new Error(`${id}: missing demonstration ${name}`);
        }
        const ship = isShipKitId(id);
        return `<section class="topic-demo-card${ship ? ' ability-card' : ''}" aria-labelledby="${headingId}"><div class="topic-demo-card-copy"><p class="eyebrow">${ship ? 'ABILITY' : 'DEMONSTRATION'}</p>${html}</div><figure class="demo" data-media="${name}"><img src="/wiki/media/${name}.png" width="640" height="360" loading="lazy" alt="${markdown.utils.escapeHtml(item.alt)}" /></figure></section>`;
      })
      .join('');
    const sections = Object.hasOwn(gameReference, id) ? (gameReference[id] ?? []) : [];
    const referenceHtml = sections
      .map(
        (section) =>
          `<section><h2>${markdown.utils.escapeHtml(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${markdown.utils.escapeHtml(paragraph)}</p>`).join('')}</section>`
      )
      .join('');
    const article: WikiArticle = {
      id,
      title,
      category,
      summary,
      order,
      html: `${bodyHtml}${referenceHtml ? `<aside class="game-reference" aria-label="Values from the game"><p class="eyebrow">CURRENT GAME VALUES · AUTOMATICALLY UPDATED</p>${referenceHtml}</aside>` : ''}`,
      searchText: flattened
        .filter(
          (token) =>
            token.type === 'text' ||
            token.type === 'code_inline' ||
            token.type === 'image' ||
            token.type === 'fence'
        )
        .map((token) => token.content)
        .join(' '),
      sections,
      related,
      sources: Object.hasOwn(articleSources, id)
        ? strings(Reflect.get(articleSources, id), `${id}.sources`)
        : [],
      media: demonstrations,
    };
    return { article, tokens: flattened };
  });
  const ids = new Set(drafts.map(({ article }) => article.id));
  for (const id of Object.keys(articleSources)) {
    if (!ids.has(id)) {
      throw new Error(`Missing required wiki article: ${id}`);
    }
  }
  for (const { article, tokens } of drafts) {
    for (const id of article.related) {
      if (!ids.has(id) || id === article.id) {
        throw new Error(`${article.id}: invalid related entry ${id}`);
      }
    }
    for (const token of tokens) {
      if (token.type === 'image') {
        const src = String(token.attrGet('src') ?? '');
        if (!/^\/wiki\/uploads\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(src)) {
          throw new Error(
            `${article.id}: images must use PNG, JPEG or WebP from wiki uploads: ${src}`
          );
        }
        if (!token.content.trim()) {
          throw new Error(`${article.id}: add descriptive image alternative text`);
        }
        if (!existsSync(resolve(root, `public${src}`))) {
          throw new Error(`${article.id}: missing image ${src}`);
        }
      }
      if (token.type !== 'link_open') {
        continue;
      }
      const href = String(token.attrGet('href') ?? '');
      if (
        /^(https?:\/\/|mailto:)/.test(href) ||
        href === '/' ||
        href === '/wiki/' ||
        href === '/wiki'
      ) {
        continue;
      }
      const target = /^(?:\/wiki\/?)?#([a-z0-9-]+)$/.exec(href)?.[1];
      if (!target || (!ids.has(target) && !reservedIds.has(target))) {
        throw new Error(
          `${article.id}: broken or unsupported link ${href}; use /wiki/#article-id for articles`
        );
      }
    }
  }
  return drafts
    .map(({ article }) => article)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
