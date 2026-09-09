// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import middleware from '../../middleware';

afterEach(() => vi.unstubAllEnvs());

describe('deployed client release identity', () => {
  it('continues the request and reports the Vercel deployment commit', () => {
    const sha = 'c31a8370f09fb452610c2a5721cf6ee7da358241';
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha);
    const response = middleware(new Request('https://www.georoids.com/'));
    expect(response.headers.get('x-release-id')).toBe(sha);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('marks a local runtime without deployment metadata as dev', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(middleware(new Request('https://www.georoids.com/')).headers.get('x-release-id')).toBe(
      'dev'
    );
  });
});

describe('published field manual routing', () => {
  it.each([
    '/wiki',
    '/wiki/',
  ])('serves the manual at %s without dropping release identity or query parameters', (path) => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'wiki-release');
    const response = middleware(new Request(`https://www.georoids.com${path}?source=game`));
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://www.georoids.com/wiki/index.html?source=game'
    );
    expect(response.headers.get('x-release-id')).toBe('wiki-release');
  });

  it('leaves demonstration assets on their ordinary static path', () => {
    const response = middleware(new Request('https://www.georoids.com/wiki/media/dart.gif'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
