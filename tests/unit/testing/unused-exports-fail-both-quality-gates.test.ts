import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Exercise the installed CLIs, including ts-prune's modern parser override.
// A successful clean scan alone would not prove that either gate detects debt.
for (const tool of ['knip', 'ts-prune']) {
  test(`${tool} accepts current TypeScript syntax and fails for an unused export`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'georoids-prune-contract-'));
    try {
      writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}');
      writeFileSync(
        join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noEmit: true },
          files: ['main.ts'],
          include: ['*.ts'],
        })
      );
      writeFileSync(
        join(directory, 'knip.json'),
        JSON.stringify({ entry: ['main.ts'], project: ['*.ts'] })
      );
      writeFileSync(
        join(directory, 'main.ts'),
        "import * as values from './values';\nconsole.log(values.current.answer);\n"
      );
      const liveCode = 'export const current = { answer: 42 } satisfies Record<string, number>;\n';
      writeFileSync(join(directory, 'values.ts'), liveCode);
      const args =
        tool === 'knip'
          ? ['--treat-config-hints-as-errors', '--treat-tag-hints-as-errors']
          : ['--error'];
      const run = () =>
        spawnSync(process.execPath, [resolve('node_modules/.bin', tool), ...args], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 15000,
        });

      const clean = run();
      expect(clean.error).toBeUndefined();
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);

      writeFileSync(join(directory, 'values.ts'), `${liveCode}export const orphan = 1;\n`);
      const unused = run();
      expect(unused.error).toBeUndefined();
      expect(unused.status, unused.stdout + unused.stderr).toBe(1);
      expect(unused.stdout + unused.stderr).toContain('orphan');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
