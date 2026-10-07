// @vitest-environment node
import { expect, test } from 'vitest';
import middleware from '../../../middleware';

for (const path of ['/debug', '/debug/']) {
  test(`a pilot opening ${path} gets the game entry with the requested log level`, () => {
    const response = middleware(new Request(`https://www.georoids.com${path}?log-level=warn`));
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://www.georoids.com/index.html?log-level=warn'
    );
  });
}

test('the manual still rewrites its query while normal gameplay passes through', () => {
  const response = middleware(new Request('https://www.georoids.com/wiki?topic=controls'));
  expect(response.headers.get('x-middleware-rewrite')).toBe(
    'https://www.georoids.com/wiki/index.html?topic=controls'
  );
  expect(
    middleware(new Request('https://www.georoids.com/')).headers.get('x-middleware-next')
  ).toBe('1');
});
