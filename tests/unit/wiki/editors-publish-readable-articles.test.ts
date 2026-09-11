import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readWikiArticles } from '../../../scripts/wiki-content';
import { getShipKit } from '../../../src/entities/ship/shipKits';
import { searchArticles } from '../../../src/wiki/search';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-editor-'));
  fixtures.push(root);
  cpSync('content', join(root, 'content'), { recursive: true });
  cpSync('public/wiki', join(root, 'public/wiki'), { recursive: true });
  return root;
}
function addArticle(root: string, body: string): void {
  writeFileSync(
    join(root, 'content/wiki/practice.md'),
    `---\ntitle: Practice\ncategory: Start here\nsummary: A new pilot practices.\norder: 200\nrelated: [content/wiki/controls.md]\n---\n${body}\n`
  );
}

test('an editor adds a formatted searchable article without changing application code', () => {
  const root = fixture();
  addArticle(
    root,
    '## First flight\n\nPractice **orbiting**.\n\n- Thrust\n- Coast\n\n[Controls](/wiki/#controls)\n\n<script>alert(1)</script>'
  );
  const articles = readWikiArticles(root);
  const article = articles.find((entry) => entry.id === 'practice');
  expect(article?.html).toContain('<strong>orbiting</strong>');
  expect(article?.html).toContain('<ul>');
  expect(article?.html).toContain('href="/wiki/#controls"');
  expect(article?.html).not.toContain('<script>');
  expect(searchArticles(articles, 'orbiting').map((entry) => entry.id)).toContain('practice');
  expect(article?.sources).toEqual([]);
  expect(article?.related).toEqual(['controls']);
  const dart = articles.find((entry) => entry.id === 'dart');
  expect(dart?.html).toContain(String(getShipKit('dart').maxHealth));
  expect(dart?.html).toContain('CURRENT GAME VALUES');
});

test('an editor cannot publish a broken article link or a missing image', () => {
  const root = fixture();
  addArticle(root, '[Missing](/wiki/#does-not-exist)');
  expect(() => readWikiArticles(root)).toThrow(/broken or unsupported link/);
  addArticle(root, '![A practice orbit](/wiki/uploads/orbit.png)');
  expect(() => readWikiArticles(root)).toThrow(/missing image/);
  mkdirSync(join(root, 'public/wiki/uploads'), { recursive: true });
  cpSync('public/wiki/media/movement.png', join(root, 'public/wiki/uploads/orbit.png'));
  expect(readWikiArticles(root).find((entry) => entry.id === 'practice')?.html).toContain(
    'alt="A practice orbit"'
  );
  addArticle(root, '![](/wiki/uploads/orbit.png)');
  expect(() => readWikiArticles(root)).toThrow(/alternative text/);
});

test('an editor keeps the old URL when renaming an article title', () => {
  const root = fixture();
  const file = join(root, 'content/wiki/controls.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/title:.*\n/, 'title: Pilot controls\n'));
  expect(readWikiArticles(root).find((entry) => entry.id === 'controls')?.title).toBe(
    'Pilot controls'
  );
});

test('the compiler accepts Pages CMS frontmatter serialization', () => {
  const root = fixture();
  const file = join(root, 'content/wiki/field-manual.md');
  const saved = readFileSync(file, 'utf8')
    .replace('\nmedia: []', '')
    .replace('---\n\n## What the manual covers', '---\n## What the manual covers')
    .replace(/\n$/, '');
  writeFileSync(file, saved);
  expect(readWikiArticles(root).find((entry) => entry.id === 'field-manual')?.title).toBe(
    'Read the field'
  );
});

test('an editor places a demonstration beside its section and repairs renamed headings', () => {
  const root = fixture();
  addArticle(root, '## First flight\n\nPractice an orbit.');
  const file = join(root, 'content/wiki/practice.md');
  const raw = readFileSync(file, 'utf8').replace(
    'order: 200',
    'order: 200\nmedia: [{demo: movement, heading: First flight}]'
  );
  writeFileSync(file, raw);
  const article = readWikiArticles(root).find((entry) => entry.id === 'practice');
  expect(article?.media).toEqual(['movement']);
  expect(article?.html).toContain('class="topic-demo-card"');
  expect(article?.html).toContain('data-media="movement"');
  writeFileSync(file, raw.replace('## First flight', '## Practice flight'));
  expect(() => readWikiArticles(root)).toThrow(/heading must match exactly one Heading 2/);
  writeFileSync(file, raw.replaceAll('First flight', 'Practice flight'));
  expect(readWikiArticles(root).find((entry) => entry.id === 'practice')?.media).toEqual([
    'movement',
  ]);
});

test('an editor cannot replace a reserved route or remove a required manual entry', () => {
  const root = fixture();
  addArticle(root, 'Practice docking.');
  cpSync(join(root, 'content/wiki/practice.md'), join(root, 'content/wiki/ships.md'));
  expect(() => readWikiArticles(root)).toThrow(/Reserved wiki ID/);
  rmSync(join(root, 'content/wiki/ships.md'));
  rmSync(join(root, 'content/wiki/field-manual.md'));
  expect(() => readWikiArticles(root)).toThrow(/Missing required wiki article/);
});
