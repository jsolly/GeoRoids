// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import middleware from '../../middleware';

afterEach(() => vi.unstubAllEnvs());

describe('deployed client release identity', () => {
  it('continues the request and reports the Vercel deployment commit', () => {
    const sha = 'c31a8370f09fb452610c2a5721cf6ee7da358241';
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', sha);
    const response = middleware();
    expect(response.headers.get('x-release-id')).toBe(sha);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('marks a local runtime without deployment metadata as dev', () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(middleware().headers.get('x-release-id')).toBe('dev');
  });
});
