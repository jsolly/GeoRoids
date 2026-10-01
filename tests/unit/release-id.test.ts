// @vitest-environment node
import { describe, expect, it as test } from 'vitest';
import middleware from '../../middleware';

describe('published field manual routing', () => {
  test.each(['/wiki', '/wiki/'])(
    'serves the manual at %s and preserves query parameters',
    (path) => {
      const response = middleware(new Request(`https://www.georoids.com${path}?source=game`));
      expect(response.headers.get('x-middleware-rewrite')).toBe(
        'https://www.georoids.com/wiki/index.html?source=game'
      );
    }
  );
  test.each(['/wiki/media/scout.gif', '/release.json', '/'])(
    'keeps %s on its ordinary static path',
    (path) => {
      const response = middleware(new Request(`https://www.georoids.com${path}`));
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    }
  );
});
