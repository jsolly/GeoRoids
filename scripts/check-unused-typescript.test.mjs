import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkUnusedTypescript, frontendEntry } from './check-unused-typescript.mjs';

test('frontend imports preserve exact TypeScript export usage without hiding new or removed consumers', () => {
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
    write(
      'tsconfig.prune.json',
      JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noUnusedLocals: true },
        include: ['src/**/*.ts'],
        files: ['src/main.ts'],
      })
    );
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
    write('src/values.ts', `${live} export const mentionedOnly = 1;`);
    write(
      'src/Comment.svelte',
      '<!-- import {mentionedOnly} from "./values" --> <p>Example only</p>'
    );
    fails('mentionedOnly');
    assert.equal(frontendEntry(root).includes('mentionedOnly'), false);
    write(
      'tsconfig.prune.json',
      JSON.stringify({ compilerOptions: { noUnusedLocals: false }, include: ['src/**/*.ts'] })
    );
    assert.throws(() => checkUnusedTypescript(root), /requires noUnusedLocals/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
