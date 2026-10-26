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
  const drop = (path) => rmSync(join(root, path));
  const run = () => checkUnusedClassMembers(root);
  const passes = () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout);
  };
  /** A clean run that still names which relationship kept this member. */
  const clears = (member, reason) => {
    const result = run();
    assert.equal(result.status, 0, result.stdout);
    const audited = result.stdout.split('\n').filter((line) => line.startsWith(`${member} `));
    assert.equal(audited.length, 1, result.stdout);
    assert(audited[0].includes(reason), audited[0]);
  };
  /** One reported line pairs this member with this remedy, and nothing else is reported. */
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
  const reached = `${live}\n  reached(): number {\n    return 3;\n  }`;
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
    // Every production directory must contribute a file, so each carries a
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

    // An ordinary caller outside the class clears the member.
    write('src/engine.ts', engine(reached));
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.reached());'
    );
    passes();
    write('src/main.ts', main);
    fails('Engine.reached', removeIt);

    // A structural type the class SATISFIES clears the member, because a caller
    // holding that port reaches it without naming the class. A type the class
    // does not satisfy is a coincidence of naming and clears nothing.
    write(
      'src/port.ts',
      'export interface Port {\n  reached(): number;\n}\nexport const hold = (p: Port) => p.reached();'
    );
    clears('Engine.reached', 'declared by a type this class satisfies at');
    drop('src/port.ts');
    write(
      'src/unrelated.ts',
      'export interface Unrelated {\n  reached(): number;\n  absent(): string;\n}'
    );
    fails('Engine.reached', removeIt);
    drop('src/unrelated.ts');
    // A declared member that cannot be called offers a caller no way to reach
    // the method, even though a method type is assignable to `unknown`.
    write(
      'src/box.ts',
      'export interface Box {\n  reached: unknown;\n}\nexport const hold = (b: Box) => b.reached;'
    );
    fails('Engine.reached', removeIt);
    drop('src/box.ts');

    // A type literal nested inside a signature is how ConnectionManager
    // .sendSnapshotResync is reached on the real tree.
    write('src/nested.ts', 'export interface Outer {\n  inner(): {reached(): number};\n}');
    clears('Engine.reached', 'declared by a type this class satisfies at');
    drop('src/nested.ts');
    // An interface nothing else mentions cannot hold a caller, so declaring one
    // must not be a way to quiet the check.
    write('src/lonely.ts', 'export interface Lonely {\n  reached(): number;\n}');
    fails('Engine.reached', removeIt);
    drop('src/lonely.ts');

    // `'name' in object` clears it when the object could be this class, and
    // not when the probed type is unrelated.
    write('src/probe.ts', 'export const probe = (v: {step(): number}) => "reached" in v;');
    clears('Engine.reached', 'probed with `in` at');
    drop('src/probe.ts');
    write('src/probe.ts', 'export const probe = (v: {absent(): string}) => "reached" in v;');
    fails('Engine.reached', removeIt);
    drop('src/probe.ts');
    write('src/wide.ts', 'export const guard = (v: object) => "reached" in v;');
    fails('Engine.reached', removeIt);
    drop('src/wide.ts');
    write(
      'src/loose.ts',
      'export const loose = (v: unknown) => typeof v === "object" && v !== null && "reached" in v;'
    );
    fails('Engine.reached', removeIt);
    drop('src/loose.ts');

    // A string naming a KEY of a related object clears it, as vi.spyOn does.
    // The same string passed where a plain `string` is expected is data.
    write(
      'src/spy.ts',
      'import {Engine} from "./engine";\ndeclare const spy: {on<T, K extends keyof T>(o: T, k: K): void};\nexport const watch = (e: Engine) => spy.on(e, "reached");'
    );
    clears('Engine.reached', 'named as a key of this class at');
    drop('src/spy.ts');
    write(
      'src/label.ts',
      'import {Engine} from "./engine";\ndeclare const label: (o: object, s: string) => void;\nexport const tag = (e: Engine) => label(e, "reached");'
    );
    fails('Engine.reached', removeIt);
    drop('src/label.ts');
    write(
      'src/emit.ts',
      'declare const emit: <T>(o: T, k: "reached" | "other") => void;\nexport const go = (o: {step(): number}) => emit(o, "reached");'
    );
    fails('Engine.reached', removeIt);
    drop('src/emit.ts');
    write(
      'src/other.ts',
      'declare const spy: {on<T, K extends keyof T>(o: T, k: K): void};\nexport const watch = (o: {reached(): number; absent(): string}) => spy.on(o, "reached");'
    );
    fails('Engine.reached', removeIt);
    drop('src/other.ts');

    // A bare string that merely shares the name reaches nothing.
    write('src/labels.ts', 'export const label = "reached";');
    fails('Engine.reached', removeIt);
    drop('src/labels.ts');

    // Bracket access needs no allowance; the language service resolves it.
    write('src/dynamic.ts', 'import {Engine} from "./engine"; new Engine()["reached"]();');
    passes();
    drop('src/dynamic.ts');

    // A caller under tests/ is a real TypeScript caller and clears the member.
    write('tests/engine.test.ts', 'import {Engine} from "../src/engine"; new Engine().reached();');
    passes();
    drop('tests/engine.test.ts');
    fails('Engine.reached', removeIt);

    // A component is not in the TypeScript program, so its call cannot clear
    // the member, but the remedy has to say so rather than claim nothing calls
    // it. Markup and Astro frontmatter count as call sites too.
    for (const [path, body] of [
      [
        'src/Panel.svelte',
        '<script lang="ts">\n  import {Engine} from "./engine";\n  new Engine().reached();\n</script>\n',
      ],
      [
        'src/Markup.svelte',
        '<script lang="ts">\n  import {Engine} from "./engine";\n  const e = new Engine();\n</script>\n<button onclick={() => e.reached()}>go</button>\n',
      ],
      [
        'src/Page.astro',
        '---\nimport {Engine} from "./engine";\nnew Engine().reached();\n---\n<div></div>\n',
      ],
    ]) {
      write(path, body);
      fails('Engine.reached', coverIt);
      drop(path);
    }
    // A component naming the member on something it did not import cannot
    // speak for this class.
    write(
      'src/Unrelated.svelte',
      '<script lang="ts">\n  const box = { reached: () => 1 };\n  box.reached();\n</script>\n'
    );
    fails('Engine.reached', removeIt);
    drop('src/Unrelated.svelte');

    // A subclass's own additions are judged; the member it overrides is cleared
    // by the reference pass, which links it to the base declaration.
    write(
      'src/sub.ts',
      'import {Engine} from "./engine";\nexport class Sub extends Engine {\n  reached(): number {\n    return 9;\n  }\n  extra(): number {\n    return 10;\n  }\n}'
    );
    write(
      'src/main.ts',
      'import {Sub} from "./sub"; const s = new Sub(); console.log(s.step(), s.reached());'
    );
    fails('Sub.extra', removeIt);
    drop('src/sub.ts');
    write('src/main.ts', main);

    // Engine is cleared from here on, so each case below reports exactly one
    // finding and that finding can only be its own.
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.reached());'
    );

    // Implementing an interface no longer exempts the whole class: the members
    // the interface declares are answered for, the rest are judged.
    write('src/shape.ts', 'export interface Shape {\n  declared(): number;\n}');
    write(
      'src/impl.ts',
      'import type {Shape} from "./shape";\nexport class Impl implements Shape {\n  declared(): number {\n    return 7;\n  }\n  undeclared(): number {\n    return 8;\n  }\n}'
    );
    fails('Impl.undeclared', removeIt);
    drop('src/impl.ts');
    drop('src/shape.ts');

    // An abstract class's concrete members are judged like any other.
    write(
      'src/abstract.ts',
      'export abstract class Base {\n  abstract hook(): void;\n  concrete(): number {\n    return 6;\n  }\n}'
    );
    fails('Base.concrete', removeIt);
    drop('src/abstract.ts');

    // A class expression declares members too, so converting a class cannot
    // drop its whole surface out of the gate.
    write(
      'src/widget.ts',
      'export const Widget = class {\n  only(): number {\n    return 8;\n  }\n};'
    );
    fails('(anonymous).only', removeIt);
    write(
      'src/widget.ts',
      'export const Widget = class {\n  only(): number {\n    return 8;\n  }\n};\nexport const held: {only(): number} = new Widget();'
    );
    passes();
    drop('src/widget.ts');

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

    // A component call outranks an internal one, because privatizing a member
    // a component calls would break its call site.
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
    drop('src/Shell.svelte');

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

    // A protected member is out of scope here, so an internal-only one is not
    // reported as over-exposed.
    write(
      'src/guarded.ts',
      'export class Guarded {\n  protected guard(): number {\n    return 1;\n  }\n  open(): number {\n    return this.guard();\n  }\n}\nexport const use = (g: Guarded) => g.open();'
    );
    passes();
    drop('src/guarded.ts');

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
