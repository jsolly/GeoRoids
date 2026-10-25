import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { test } from 'vitest';
import unusedConfig from '../config/quality/knip.js';
import { checkUnusedTypescript, frontendEntry } from './check-unused-typescript.mjs';

test('frontend imports and inherited tool entries preserve exact TypeScript export usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-frontend-prune-contract-'));
  const write = (path, body) => writeFileSync(join(root, path), body);
  const run = () => checkUnusedTypescript(root);
  const passes = () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const fails = (name) => {
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(name, 'u'));
  };
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'config/typescript'), { recursive: true });
    write(
      'config/typescript/base.json',
      JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noUnusedLocals: true },
      })
    );
    write(
      'config/typescript/prune.jsonc',
      JSON.stringify({
        extends: './base.json',
        compilerOptions: { allowJs: true },
        include: [
          '../../src/**/*.ts',
          '../../scripts/**/*.mjs',
          '../../config/app/**/*.ts',
          '../../config/testing/**/*.ts',
        ],
        files: ['../../tool.config.ts'],
      })
    );
    // This consumer is outside include: losing inherited files exposes onlyTool as unused.
    write('tool.config.ts', 'import {onlyTool} from "./src/tool-only"; console.log(onlyTool);');
    write('src/tool-only.ts', 'export const onlyTool = 1;');
    write('src/main.ts', 'console.log("entry");');
    const live = 'export const shown = 42; export type Shape = {size:number};';
    write('src/values.ts', live);
    write(
      'src/Panel.svelte',
      '<script lang="ts">import {shown, type Shape} from "./values"; const size: Shape = {size: shown};</script><p>{size.size}</p>'
    );
    passes();
    write('src/values.ts', `${live} export const orphan = 1;`);
    fails('orphan');
    write('src/values.ts', live);
    rmSync(join(root, 'src/Panel.svelte'));
    fails('shown');
    write(
      'src/Page.astro',
      '---\nimport {shown} from "./values"; import type {Shape} from "./values"; const size: Shape = {size:shown};\n---\n<p>{size.size}</p>'
    );
    passes();
    write('src/Page.astro', '<script>import {shown} from "./values"; console.log(shown);</script>');
    fails('Shape');
    write(
      'src/Page.astro',
      '---\nimport type {Shape} from "./values"; const size: Shape = {size:1};\n---\n<p>{size.size}</p><script>import {shown} from "./values"; console.log(shown);</script>'
    );
    passes();
    write('src/content.config.ts', 'export const collections = {}; export const orphanConfig = 1;');
    fails('orphanConfig');
    write('src/content.config.ts', 'export const collections = {};');
    passes();
    mkdirSync(join(root, 'config/app'));
    mkdirSync(join(root, 'config/testing'));
    write('config/app/astro.ts', 'export default {}; export const orphanAstro = 1;');
    write('config/testing/vitest.ts', 'export default {};');
    fails('orphanAstro');
    write('config/app/astro.ts', 'export default {};');
    passes();
    write('config/testing/vitest.ts', 'export default {}; export const orphanVitest = 1;');
    fails('orphanVitest');
    write('config/testing/vitest.ts', 'export default {};');
    passes();
    // The release machinery under scripts/ is authored as .mjs, so allowJs keeps
    // those modules in this program; Knip stops checking a module's exports once
    // a path string reaches it, which covers most of those runners.
    mkdirSync(join(root, 'scripts'));
    write('scripts/runner.mjs', 'export function used() {\n  return 1;\n}');
    write('src/main.ts', 'import {used} from "../scripts/runner.mjs"; console.log(used());');
    passes();
    write(
      'scripts/runner.mjs',
      'export function used() {\n  return 1;\n}\nexport const spare = 2;'
    );
    fails('spare');
    write('scripts/runner.mjs', 'export function used() {\n  return 1;\n}');
    write('src/main.ts', 'console.log("entry");');
    fails('used');
    rmSync(join(root, 'scripts/runner.mjs'));
    write('src/values.ts', `${live} export const mentionedOnly = 1;`);
    write(
      'src/Comment.svelte',
      '<!-- import {mentionedOnly} from "./values" --> <p>Example only</p>'
    );
    fails('mentionedOnly');
    assert.equal(frontendEntry(root).includes('mentionedOnly'), false);
    write(
      'config/typescript/prune.jsonc',
      JSON.stringify({ compilerOptions: { noUnusedLocals: false }, include: ['src/**/*.ts'] })
    );
    assert.throws(() => checkUnusedTypescript(root), /requires noUnusedLocals/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the committed prune program keeps the scripts/ .mjs runners in scope', () => {
  const configPath = resolve('config/typescript/prune.jsonc');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  assert.equal(parsed.options.allowJs, true, 'Unused .mjs exports need allowJs');
  const runners = parsed.fileNames.filter((path) => /scripts\/[^/]+\.mjs$/u.test(path));
  assert.ok(runners.length > 10, `Expected the scripts/ runners in scope, saw ${runners.length}`);
  // A sibling declaration file wins module resolution, so its .mjs never enters
  // the program and no gate can report that module's unused exports.
  const shadowed = parsed.fileNames.filter((path) => path.endsWith('.d.mts'));
  assert.deepEqual(
    shadowed.map((path) => relative(process.cwd(), path)),
    ['scripts/validation-admission.d.mts'],
    'A new hand-written declaration file hides its .mjs from the unused-export gate'
  );
});

test('the unused-file gate rejects an orphaned Svelte component and follows its Astro consumer', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'georoids-svelte-prune-contract-')));
  const write = (path, body) => writeFileSync(join(root, path), body);
  const config = unusedConfig;
  assert.ok(config, 'Cannot read the committed unused-file configuration');
  const run = () =>
    spawnSync(
      process.execPath,
      [
        resolve('node_modules/knip/bin/knip.js'),
        '--directory',
        root,
        '--include',
        'files',
        '--no-progress',
        '--treat-config-hints-as-errors',
        '--treat-tag-hints-as-errors',
      ],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, JITI_FS_CACHE: 'false' } }
    );
  try {
    mkdirSync(join(root, 'src/pages'), { recursive: true });
    mkdirSync(join(root, 'src/components'));
    write(
      'package.json',
      JSON.stringify({
        type: 'module',
        dependencies: { astro: '7.3.8', svelte: '5.57.2', tailwindcss: '4.3.3' },
      })
    );
    write(
      'knip.json',
      JSON.stringify({
        entry: config.entry.filter((pattern) => pattern.startsWith('src/')),
        project: config.project.filter((pattern) => pattern.startsWith('src/')),
      })
    );
    write('src/pages/index.astro', '<p>Live page</p>');
    write('src/components/Orphan.svelte', '<p>Orphan</p>');
    const orphan = run();
    assert.equal(orphan.status, 1, orphan.stdout + orphan.stderr);
    assert.match(orphan.stdout, /src\/components\/Orphan\.svelte/u);
    write(
      'src/pages/index.astro',
      '---\nimport Panel from "../components/Orphan.svelte";\n---\n<Panel/>'
    );
    const live = run();
    assert.equal(live.status, 0, live.stdout + live.stderr);
    write(
      'src/pages/index.astro',
      '<!-- import Panel from "../components/Orphan.svelte" --> <p>Live page</p>'
    );
    const mentioned = run();
    assert.equal(mentioned.status, 1, mentioned.stdout + mentioned.stderr);
    assert.match(mentioned.stdout, /src\/components\/Orphan\.svelte/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
