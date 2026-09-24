import { describe, expect, it as test } from 'vitest';
import { readWikiArticles } from '../../../scripts/wiki-content';

const articles = readWikiArticles();

import { searchArticles } from '../../../src/wiki/search';

describe('readers find mechanics in the field manual', () => {
  test('finds rules in article bodies even when they are absent from the title', () => {
    const results = searchArticles(articles, 'classification');
    expect(results.some((article) => article.id === 'scout')).toBe(true);
  });

  test.each([
    ['Scout', 'scout'],
    ['Systems', 'hud-network'],
    ['nimble', 'scout'],
    ['materials', 'asteroids'],
  ])('finds %s in the published reference', (query, id) => {
    expect(searchArticles(articles, query).some((article) => article.id === id)).toBe(true);
  });

  test('ignores letter case and extra spaces', () => {
    expect(searchArticles(articles, '  HARPOON  ')).toEqual(searchArticles(articles, 'harpoon'));
  });

  test('requires all search words and returns an empty result for an unknown mechanic', () => {
    expect(searchArticles(articles, 'harpoon nonexistent-mechanic')).toEqual([]);
  });

  test('returns the full inventory for an empty query', () => {
    expect(searchArticles(articles, '   ')).toEqual(articles);
  });
});
