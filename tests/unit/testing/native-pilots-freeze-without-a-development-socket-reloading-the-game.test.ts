/* @vitest-environment node */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import {
  disableViteClientTransport,
  ownedGroupAbsentInInventory,
} from '../../support/native-lifecycle-browser';

const require = createRequire(import.meta.url);
const vitePackage = require.resolve('vite/package.json');
const source = readFileSync(join(dirname(vitePackage), 'dist/client/client.mjs'), 'utf8');
const boot = 'transport.connect(createHMRHandler(handleMessage));';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

test('native pilots keep the pinned Vite CSS and hot disposal module while omitting its development socket bootstrap', () => {
  // A Vite upgrade must review this test-only interception against the new client.
  expect(JSON.parse(readFileSync(vitePackage, 'utf8')).version).toBe('8.3.0');
  expect(sha256(source)).toBe('d5a2258b7915fc2e70077dd20b63892e553b1ef4344c95621e226875f8897962');
  const start = source.indexOf(boot);
  expect(start).toBeGreaterThan(0);
  const before = source.slice(0, start);
  const after = source.slice(start + boot.length);
  const transformed = disableViteClientTransport(source);
  expect(transformed.body).toBe(before + after);
  expect(transformed.body.length).toBe(source.length - boot.length);
  expect(transformed.body).not.toContain(boot);
  expect(transformed.body).toContain(
    'export { ErrorOverlay, createHotContext, injectQuery, removeStyle, updateStyle };'
  );
  expect(transformed.body).toContain('function createHotContext(');
  expect(transformed.body).toContain('function updateStyle(');
  expect(transformed.body).toContain('function removeStyle(');
  expect(transformed.body).toContain('await activeHmrClient.prunePaths(payload.paths)');
  expect(transformed.originalSha256).toBe(sha256(source));
  expect(transformed.transformedSha256).toBe(sha256(before + after));
});

test.each([
  ['absent', source.replace(boot, '')],
  ['duplicated', `${source}\n${boot}\n`],
  ['changed', source.replace(boot, 'transport.connect(createHMRHandler(otherHandler));')],
  ['commented', source.replace(boot, `// ${boot}`)],
])('native pilots fail closed when the Vite transport bootstrap is %s', (_case, changed) => {
  expect(() => disableViteClientTransport(changed)).toThrow('Vite');
});

test('native browser cleanup retains a surviving child after its group leader exits', () => {
  expect(ownedGroupAbsentInInventory('  1 1\n  65300 63527\n  65301 65301\n', 63527)).toBe(false);
  expect(ownedGroupAbsentInInventory('  1 1\n  65301 65301\n', 63527)).toBe(true);
});

test.each(['', 'PID PGID\n1 1\n', '1 1\n2 ?\n', '1 1\n1 2\n'])(
  'native browser cleanup retains its profile when the process inventory cannot prove group absence',
  (inventory) => expect(() => ownedGroupAbsentInInventory(inventory, 63527)).toThrow()
);
