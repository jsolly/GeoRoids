import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkUnusedClassMembers } from './check-unused-class-members.mjs';

const removeIt = 'no TypeScript references; remove it';
const coverIt = 'only a component calls it; cover the behavior from a test';
const makePrivate = (count) => `used only inside its class (${count}); make it private`;

test('public production methods need a caller outside their own class', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-class-member-contract-'));
  const write = (path, body) => writeFileSync(join(root, path), body);
  const run = () => checkUnusedClassMembers(root);
  const passes = () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout);
  };
  /** One reported line must pair this member with this remedy, and report it once. */
  const fails = (member, remedy, total = 1) => {
    const result = run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, new RegExp(`^Unused public class members \\(${total}\\)\n`, 'u'));
    const reported = result.stdout.split('\n').filter((line) => line.startsWith(`${member} `));
    assert.equal(reported.length, 1, result.stdout);
    assert(reported[0].endsWith(` - ${remedy}`), reported[0]);
  };
  const engine = (members) => `export class Engine {\n${members}\n}`;
  const live = '  step(): number {\n    return 1;\n  }';
  /** The only caller of Engine.step, so the baseline has no finding. */
  const main = 'import {Engine} from "./engine"; console.log(new Engine().step());';
  try {
    for (const directory of ['src', 'server', 'shared', 'tests']) {
      mkdirSync(join(root, directory));
    }
    mkdirSync(join(root, 'config/typescript'), { recursive: true });
    write(
      'config/typescript/base.json',
      JSON.stringify({
        compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', strict: true },
      })
    );
    write(
      'config/typescript/prune.jsonc',
      JSON.stringify({
        extends: './base.json',
        include: [
          '../../src/**/*.ts',
          '../../server/**/*.ts',
          '../../shared/**/*.ts',
          '../../tests/**/*.ts',
        ],
      })
    );
    // Every production directory must contribute a file, so each one carries a
    // class whose single public method has a caller.
    write('server/host.ts', 'export class Host {\n  listen(): number {\n    return 4;\n  }\n}');
    write('shared/rules.ts', 'export class Rules {\n  apply(): number {\n    return 5;\n  }\n}');
    write(
      'tests/world.test.ts',
      'import {Host} from "../server/host";\nimport {Rules} from "../shared/rules";\nnew Host().listen();\nnew Rules().apply();'
    );
    write('src/engine.ts', engine(live));
    write('src/main.ts', main);
    passes();

    // A method nothing reaches at all, and one only its own class reaches.
    write('src/engine.ts', engine(`${live}\n  orphan(): number {\n    return 2;\n  }`));
    fails('Engine.orphan', removeIt);
    write(
      'src/engine.ts',
      engine(`${live}\n  helper(): number {\n    return this.step();\n  }\n
  inner(): number {\n    return this.helper();\n  }`)
    );
    // Two findings: inner is dead, and helper is over-exposed because only
    // inner reaches it.
    fails('Engine.inner', removeIt, 2);

    // A caller outside the class clears the member, through any of the ways a
    // caller can reach it without naming the class.
    write('src/engine.ts', engine(`${live}\n  reached(): number {\n    return 3;\n  }`));
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.reached());'
    );
    passes();
    write('src/main.ts', main);
    fails('Engine.reached', removeIt);
    write('src/port.ts', 'export interface Port {\n  reached(): number;\n}');
    passes();
    rmSync(join(root, 'src/port.ts'));
    write('src/probe.ts', 'export const probe = (v: object) => "reached" in v;');
    passes();
    rmSync(join(root, 'src/probe.ts'));
    write('src/spy.ts', 'export const spy = (t: object) => Object.keys(t).includes("reached");');
    passes();
    rmSync(join(root, 'src/spy.ts'));

    // A bare string that happens to share the name is not a way to reach it,
    // so an unrelated literal must not clear the finding.
    write('src/labels.ts', 'export const label = "reached";');
    fails('Engine.reached', removeIt);
    rmSync(join(root, 'src/labels.ts'));

    // Bracket access needs no allowance; the service resolves it.
    write('src/dynamic.ts', 'import {Engine} from "./engine"; new Engine()["reached"]();');
    passes();
    rmSync(join(root, 'src/dynamic.ts'));

    // A caller under tests/ is a real TypeScript caller and clears the member.
    // AGENTS.md sends an author here when only a component calls a method, so
    // this stays pinned: WikiScrollMemory's public surface relies on it.
    write('tests/engine.test.ts', 'import {Engine} from "../src/engine"; new Engine().reached();');
    passes();
    rmSync(join(root, 'tests/engine.test.ts'));
    fails('Engine.reached', removeIt);

    // A component is not in the TypeScript program, so its call cannot clear
    // the member, but the remedy has to say so rather than claim nothing calls it.
    write(
      'src/Panel.svelte',
      '<script lang="ts">\n  import {Engine} from "./engine";\n  new Engine().reached();\n</script>\n'
    );
    fails('Engine.reached', coverIt);
    rmSync(join(root, 'src/Panel.svelte'));
    write(
      'src/Markup.svelte',
      '<script lang="ts">\n  import {Engine} from "./engine";\n  const e = new Engine();\n</script>\n<button onclick={() => e.reached()}>go</button>\n'
    );
    fails('Engine.reached', coverIt);
    rmSync(join(root, 'src/Markup.svelte'));
    write(
      'src/Page.astro',
      '---\nimport {Engine} from "./engine";\nnew Engine().reached();\n---\n<div></div>\n'
    );
    fails('Engine.reached', coverIt);
    rmSync(join(root, 'src/Page.astro'));
    // A component that names the member on something it did not import cannot
    // speak for this class, or a DOM member of the same name would keep dead
    // code alive.
    write(
      'src/Unrelated.svelte',
      '<script lang="ts">\n  const box = { reached: () => 1 };\n  box.reached();\n</script>\n'
    );
    fails('Engine.reached', removeIt);
    rmSync(join(root, 'src/Unrelated.svelte'));

    // A component call outranks an internal one, because privatizing the member
    // would break the component's call site.
    write(
      'src/engine.ts',
      engine(`${live}\n  private wrapped(): number {\n    return this.shared();\n  }\n
  shared(): number {\n    return this.step();\n  }\n
  expose(): number {\n    return this.wrapped();\n  }`)
    );
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.expose());'
    );
    fails('Engine.shared', makePrivate(1));
    write(
      'src/Shell.svelte',
      '<script lang="ts">\n  import {Engine} from "./engine";\n  new Engine().shared();\n</script>\n'
    );
    fails('Engine.shared', coverIt);
    rmSync(join(root, 'src/Shell.svelte'));
    write('src/engine.ts', engine(`${live}\n  reached(): number {\n    return 3;\n  }`));
    write('src/main.ts', main);
    fails('Engine.reached', removeIt);

    // Heritage, abstract classes and extended classes answer to their own
    // contract, so none of their members is judged here. Engine is cleared
    // first, so each case below can only report its own class.
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.reached());'
    );
    write('src/sub.ts', 'import {Engine} from "./engine"; export class Sub extends Engine {}');
    passes();
    rmSync(join(root, 'src/sub.ts'));
    write(
      'src/abstract.ts',
      'export abstract class Base {\n  unused(): number {\n    return 6;\n  }\n}'
    );
    passes();
    rmSync(join(root, 'src/abstract.ts'));
    write('src/shape.ts', 'export interface Shape {\n  other(): number;\n}');
    write(
      'src/impl.ts',
      'import type {Shape} from "./shape";\nexport class Impl implements Shape {\n  unused(): number {\n    return 7;\n  }\n}'
    );
    passes();
    rmSync(join(root, 'src/impl.ts'));
    rmSync(join(root, 'src/shape.ts'));
    write('src/lonely.ts', 'export class Lonely {\n  idle(): number {\n    return 11;\n  }\n}');
    fails('Lonely.idle', removeIt);
    write(
      'tests/child.test.ts',
      'import {Lonely} from "../src/lonely"; export class Child extends Lonely {}'
    );
    passes();
    rmSync(join(root, 'tests/child.test.ts'));
    fails('Lonely.idle', removeIt);
    rmSync(join(root, 'src/lonely.ts'));

    // A class expression declares members too, so converting a class cannot
    // drop its whole surface out of the gate.
    write(
      'src/widget.ts',
      'export const Widget = class {\n  only(): number {\n    return 8;\n  }\n};'
    );
    fails('(anonymous).only', removeIt);
    rmSync(join(root, 'src/widget.ts'));

    // Members used only inside the class are over-exposed, not dead.
    write(
      'src/engine.ts',
      engine(`${live}\n  private wrapped(): number {\n    return this.widened();\n  }\n
  widened(): number {\n    return this.step();\n  }\n
  expose(): number {\n    return this.wrapped();\n  }`)
    );
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.expose());'
    );
    fails('Engine.widened', makePrivate(1));

    // Overload signatures declare the same member rather than using it, so they
    // never inflate the count that decides whether private would still work.
    write(
      'src/engine.ts',
      engine(`${live}\n  private wrapped(): number {\n    return this.over(1);\n  }\n
  over(value: number): number;\n  over(value: string): number;\n
  over(value: number | string): number {\n    return typeof value === 'number' ? value : 0;\n  }\n
  expose(): number {\n    return this.wrapped();\n  }`)
    );
    fails('Engine.over', makePrivate(1));

    // Every production directory is judged, not just src/.
    write('src/engine.ts', engine(live));
    write('src/main.ts', main);
    write(
      'server/host.ts',
      'export class Host {\n  listen(): number {\n    return 4;\n  }\n  idle(): number {\n    return 9;\n  }\n}'
    );
    fails('Host.idle', removeIt);
    write('server/host.ts', 'export class Host {\n  listen(): number {\n    return 4;\n  }\n}');
    write(
      'shared/rules.ts',
      'export class Rules {\n  apply(): number {\n    return 5;\n  }\n  spare(): number {\n    return 10;\n  }\n}'
    );
    fails('Rules.spare', removeIt);
    write('shared/rules.ts', 'export class Rules {\n  apply(): number {\n    return 5;\n  }\n}');

    // Test doubles and other non-production classes stay out of scope.
    write('tests/double.test.ts', 'export class FakeSocket {\n  send(): void {}\n}');
    passes();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a configuration that cannot be trusted fails instead of reporting nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-class-member-scope-'));
  const write = (path, body) => writeFileSync(join(root, path), body);
  const config = (include) =>
    write('config/typescript/prune.jsonc', JSON.stringify({ extends: './base.json', include }));
  try {
    for (const directory of ['src', 'server', 'shared', 'tests']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    mkdirSync(join(root, 'config/typescript'), { recursive: true });
    write('config/typescript/base.json', JSON.stringify({ compilerOptions: { strict: true } }));
    write('src/engine.ts', 'export class Engine {\n  step(): number {\n    return 1;\n  }\n}');
    write('server/host.ts', 'export class Host {\n  listen(): number {\n    return 4;\n  }\n}');
    write('shared/rules.ts', 'export class Rules {\n  apply(): number {\n    return 5;\n  }\n}');
    write('tests/only.test.ts', 'export const only = 1;');

    // A program that resolves files but no production file would report a clean
    // run over nothing at all, so it is a failure rather than a pass.
    config(['../../tests/**/*.ts']);
    assert.throws(() => checkUnusedClassMembers(root), /resolved no production files/u);

    // One mistyped entry drops a whole directory without a configuration error,
    // because TypeScript only reports an entirely empty program.
    config(['../../src/**/*.ts', '../../serverr/**/*.ts', '../../shared/**/*.ts']);
    assert.throws(() => checkUnusedClassMembers(root), /under these directories/u);

    // A rejected compiler option fails before any program is built.
    write(
      'config/typescript/prune.jsonc',
      JSON.stringify({
        extends: './base.json',
        compilerOptions: { target: 'NOT_A_TARGET' },
        include: ['../../src/**/*.ts', '../../server/**/*.ts', '../../shared/**/*.ts'],
      })
    );
    assert.throws(() => checkUnusedClassMembers(root), /did not parse/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the gate runs this check alongside the unused-export check', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts.scripts['check:ts-prune'], /check-unused-class-members\.mjs/u);
});
