/* @vitest-environment node */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const hook = fileURLToPath(new URL('../../../.git-hooks/pre-push', import.meta.url));
const oid = '1'.repeat(40);
function push(destinations: string[], override = '0') {
  return spawnSync(hook, ['origin', 'https://github.com/jsolly/GeoRoids.git'], {
    input: destinations.map((destination) => `HEAD ${oid} ${destination} ${oid}\n`).join(''),
    encoding: 'utf8',
    env: { ...process.env, GEOROIDS_BREAK_GLASS_PUSH: override },
  });
}

test('feature pushes pass but a main destination blocks the whole push even in a multi-ref update', () => {
  expect(push(['refs/heads/fix/game-loop']).status).toBe(0);
  for (const destinations of [
    ['refs/heads/main'],
    ['refs/heads/fix/game-loop', 'refs/heads/main'],
  ]) {
    const result = push(destinations);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Direct pushes to main are blocked');
  }
});

test('an explicit emergency override permits main and leaves a visible warning', () => {
  const result = push(['refs/heads/main'], '1');
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('Explicit break-glass override');
  expect(push(['refs/heads/main'], 'true').status).toBe(1);
});
