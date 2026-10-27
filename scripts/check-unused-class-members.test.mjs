import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkUnusedClassMembers } from './check-unused-class-members.mjs';
import { STAGES } from './gate-receipt.mjs';

const removeIt = 'no TypeScript references; remove it';
const coverIt = 'only a component reaches it; cover the behavior from a test';
const makePrivate = (count) => `used only inside its class (${count}); make it private`;
const engine = (members) => `export class Engine {\n${members}\n}`;
const live = '  step(): number {\n    return 1;\n  }';
/** The only caller of Engine.step, so the baseline has no finding. */
const main = 'import {Engine} from "./engine"; console.log(new Engine().step());';

/**
 * A tree the check can be run over, with one class per production directory so
 * that every directory contributes a file and the baseline is clean.
 */
function fixture(name) {
  const root = mkdtempSync(join(tmpdir(), `georoids-class-member-${name}-`));
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
  write('server/host.ts', 'export class Host {\n  listen(): number {\n    return 4;\n  }\n}');
  write('shared/rules.ts', 'export class Rules {\n  apply(): number {\n    return 5;\n  }\n}');
  write(
    'tests/world.test.ts',
    'import {Host} from "../server/host";\nimport {Rules} from "../shared/rules";\nnew Host().listen();\nnew Rules().apply();'
  );
  write('src/engine.ts', engine(live));
  write('src/main.ts', main);
  // The baseline runs before `root` is handed back, so the caller's `finally`
  // cannot release it yet.
  try {
    passes();
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, write, drop, run, passes, clears, fails };
}

test('public production methods need a caller outside their own class', () => {
  const { root, write, drop, passes, clears, fails } = fixture('methods');
  const reached = `${live}\n  reached(): number {\n    return 3;\n  }`;
  try {
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
    // The port is EXERCISED here on purpose, so only assignability can reject
    // it. Without the `hold` line the exercised-port rule rejects it first and
    // the case pins neither condition.
    write(
      'src/unrelated.ts',
      'export interface Unrelated {\n  reached(): number;\n  absent(): string;\n}\nexport const hold = (u: Unrelated) => u.reached();'
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
    // .sendSnapshotResync is reached on the real tree, where the event loop
    // calls it through the port.
    write(
      'src/nested.ts',
      'export interface Outer {\n  inner(): {reached(): number};\n}\nexport const go = (o: Outer) => o.inner().reached();'
    );
    clears('Engine.reached', 'declared by a type this class satisfies at');
    drop('src/nested.ts');
    // The port has to be exercised. A shape nothing ever touches reaches
    // nothing, whether it is nested in a signature or declared as an interface,
    // so writing one is not a way to quiet the check.
    write(
      'src/nested.ts',
      'export interface Outer {\n  inner(): {reached(): number};\n}\nexport const hold = (o: Outer) => o.inner();'
    );
    fails('Engine.reached', removeIt);
    drop('src/nested.ts');
    write('src/lonely.ts', 'export interface Lonely {\n  reached(): number;\n}');
    fails('Engine.reached', removeIt);
    drop('src/lonely.ts');
    // A `Pick` of an exercised interface resolves to the same member, which is
    // how Ship.tapExtractFrames is reached on the real tree.
    write(
      'src/picked.ts',
      'export interface Host {\n  reached(): number;\n  step(): number;\n}\nexport const go = (h: Pick<Host, "reached">) => h.reached();'
    );
    clears('Engine.reached', 'declared by a type this class satisfies at');
    drop('src/picked.ts');

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

    // A heritage clause answers for nothing on its own. The service returns the
    // interface's own member DECLARATION among the class member's references,
    // and counting that as a use would let one `implements` clause retire a
    // member from the gate silently -- no finding and no audit line.
    write('src/shape.ts', 'export interface Shape {\n  declared(): number;\n}');
    const impl =
      'import type {Shape} from "./shape";\nexport class Impl implements Shape {\n  declared(): number {\n    return 7;\n  }\n  undeclared(): number {\n    return 8;\n  }\n}';
    write('src/impl.ts', impl);
    fails('Impl.declared', removeIt, 2);
    fails('Impl.undeclared', removeIt, 2);
    // Exercise the port and the implementing member has a genuine reference
    // through it, so the reference pass clears it and no type rule is needed;
    // the member the port does not declare is still judged.
    write(
      'src/shape.ts',
      'export interface Shape {\n  declared(): number;\n}\nexport const hold = (s: Shape) => s.declared();'
    );
    fails('Impl.undeclared', removeIt);
    // A second class implementing the port is not a caller either.
    write('src/shape.ts', 'export interface Shape {\n  declared(): number;\n}');
    write(
      'src/other.ts',
      'import type {Shape} from "./shape";\nexport class Other implements Shape {\n  declared(): number {\n    return 9;\n  }\n}'
    );
    fails('Impl.declared', removeIt, 3);
    drop('src/other.ts');
    // Nor is a repeated declaration of the port member: an overload signature
    // declares it twice, and neither declaration reaches anything.
    write(
      'src/shape.ts',
      'export interface Shape {\n  declared(): number;\n  declared(n: number): number;\n}'
    );
    fails('Impl.declared', removeIt, 2);
    drop('src/impl.ts');
    drop('src/shape.ts');

    // A field is reached the same way, so the same clause cannot retire one.
    write('src/held.ts', 'export interface Held {\n  stored: number;\n}');
    write(
      'src/store.ts',
      'import type {Held} from "./held";\nexport class Store implements Held {\n  stored = 1;\n}'
    );
    fails('Store.stored', removeIt);
    drop('src/store.ts');
    drop('src/held.ts');

    // A subclass that redeclares a base member reaches nothing either: before,
    // each declaration cleared the other and both dead methods passed.
    write(
      'src/hierarchy.ts',
      'export class Base {\n  hook(): number {\n    return 1;\n  }\n}\nexport class Leaf extends Base {\n  hook(): number {\n    return 2;\n  }\n}'
    );
    fails('Base.hook', removeIt, 2);
    fails('Leaf.hook', removeIt, 2);
    drop('src/hierarchy.ts');

    // An abstract class's concrete members are judged like any other, while an
    // abstract member defers to whatever implements it. The abstract FIELD is
    // the discriminating case: an abstract method is already excluded for
    // having no body.
    write(
      'src/abstract.ts',
      'export abstract class Base {\n  abstract hook(): void;\n  abstract slot: number;\n  concrete(): number {\n    return 6;\n  }\n}'
    );
    fails('Base.concrete', removeIt);
    drop('src/abstract.ts');

    // An object literal that SATISFIES a port declares the member too, so it
    // cannot stand in for a caller either. Before, the verdict depended on the
    // spelling: `{ declared() {} }` parses as a method declaration and was
    // rejected, while the arrow and field spellings of the same thing retired
    // the member with no finding and no audit line.
    write('src/shape.ts', 'export interface Shape {\n  declared(): number;\n}');
    write(
      'src/impl.ts',
      'import type {Shape} from "./shape";\nexport class Impl implements Shape {\n  declared(): number {\n    return 1;\n  }\n}'
    );
    for (const stub of [
      'import type {Shape} from "./shape";\nexport const stub: Shape = { declared: () => 9 };',
      'import type {Shape} from "./shape";\nconst declared = () => 9;\nexport const stub: Shape = { declared };',
    ]) {
      write('src/stub.ts', stub);
      fails('Impl.declared', removeIt);
    }
    drop('src/stub.ts');
    drop('src/impl.ts');
    drop('src/shape.ts');

    // The same omission let one object-literal line clear a member through a
    // port the class does not even implement, and that clearance PRINTED an
    // audit line claiming a relationship something exercises -- a reader
    // auditing the output was misled rather than informed.
    write('src/main.ts', main);
    write('src/relay.ts', 'export interface Relay {\n  relayed(): number;\n}');
    write(
      'src/stub.ts',
      'import type {Relay} from "./relay";\nexport const stub: Relay = { relayed: () => 9 };'
    );
    write('src/engine.ts', engine(`${live}\n  relayed(): number {\n    return 2;\n  }`));
    fails('Engine.relayed', removeIt);
    // Exercise the port and the clearance becomes honest.
    write(
      'src/relay.ts',
      'export interface Relay {\n  relayed(): number;\n}\nexport const hold = (r: Relay): number => r.relayed();'
    );
    clears('Engine.relayed', 'declared by a type this class satisfies');
    write('src/engine.ts', engine(live));
    drop('src/stub.ts');
    drop('src/relay.ts');

    // A reference the classifier cannot resolve to an access is not a use. A
    // doc comment names a member without calling it, and `forEachChild` does
    // not descend into JSDoc, so defaulting to `read` let one comment retire a
    // member permanently.
    write('src/main.ts', main);
    write(
      'src/doc.ts',
      'import type {Engine} from "./engine";\n/** See {@link Engine.spare} for the value. */\nexport type Doc = Engine;'
    );
    write('src/engine.ts', engine(`${live}\n  spare = 0;`));
    fails('Engine.spare', removeIt);
    drop('src/doc.ts');
    // An indexed-access TYPE names the member's type and calls nothing, so it
    // cannot keep an otherwise dead member alive either.
    write(
      'src/engine.ts',
      `${engine(`${live}\n  spare = 0;`)}\nexport type Spare = Engine["spare"];`
    );
    fails('Engine.spare', removeIt);
    write('src/engine.ts', engine(live));

    // An `override` member is judged like any other. The exclusion that used
    // to skip it was a workaround for counting a base declaration as a use,
    // and once that stopped, one keyword silently retired a public member --
    // the whole battery stayed green with the exclusion deleted.
    write('src/main.ts', main);
    write(
      'src/hierarchy.ts',
      'export class Base {\n  hook(): number {\n    return 1;\n  }\n}\nexport class Leaf extends Base {\n  override hook(): number {\n    return 2;\n  }\n}'
    );
    fails('Base.hook', removeIt, 2);
    fails('Leaf.hook', removeIt, 2);
    drop('src/hierarchy.ts');
    // An abstract base defers to its implementation, so if the implementation
    // also deferred, each pointed at the other and nobody judged either.
    write(
      'src/hierarchy.ts',
      'export abstract class Base {\n  abstract hook(): number;\n  run(): number {\n    return 1;\n  }\n}\nexport class Leaf extends Base {\n  override hook(): number {\n    return 2;\n  }\n}'
    );
    write(
      'src/lift.ts',
      'import {Leaf} from "./hierarchy";\nexport const lift = () => new Leaf().run();'
    );
    fails('Leaf.hook', removeIt);
    drop('src/lift.ts');
    drop('src/hierarchy.ts');

    // A class expression declares members too, so converting a class cannot
    // drop its whole surface out of the gate.
    write(
      'src/widget.ts',
      'export const Widget = class {\n  only(): number {\n    return 8;\n  }\n};'
    );
    fails('(anonymous).only', removeIt);
    write(
      'src/widget.ts',
      'export const Widget = class {\n  only(): number {\n    return 8;\n  }\n};\nconst held: {only(): number} = new Widget();\nexport const go = () => held.only();'
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

test('public fields and accessors are judged like methods', () => {
  const { root, write, drop, run, passes, clears, fails } = fixture('fields');
  /** Mirror.total always has an outside caller, so each case reports only its own field. */
  const mirror = (members) =>
    `export class Mirror {\n  total(): number {\n    return 0;\n  }\n${members}\n}`;
  const view = (body) => `import type {Mirror} from "./mirror";\n${body}`;
  const reads = view('export const show = (m: Mirror) => m.total();');
  try {
    write('src/view.ts', view('export const show = (m: Mirror) => m.total() + m.live;'));
    write('src/mirror.ts', mirror('  live = 1;'));
    passes();

    // A field nothing names at all, and one only its own class reads.
    write('src/view.ts', reads);
    fails('Mirror.live', removeIt);
    write(
      'src/mirror.ts',
      'export class Mirror {\n  inner = 1;\n  total(): number {\n    return this.inner;\n  }\n}'
    );
    fails('Mirror.inner', makePrivate(1));

    // A field nothing reads is dead storage wherever it is written from, so the
    // remedy is removal rather than a narrowing Biome would then report.
    const stored =
      'export class Mirror {\n  stored = 0;\n  total(): number {\n    this.stored += 1;\n    return 0;\n  }\n}';
    write('src/mirror.ts', stored);
    fails('Mirror.stored', 'written but never read (1); remove it');
    // An assignment from outside is a use of the field, so it is not reported.
    // Nothing here establishes that anything reads it, which is deliberate:
    // the alternative reports a field whose only reader is a serializer.
    write('src/view.ts', view('export const set = (m: Mirror) => {\n  m.stored = m.total();\n};'));
    passes();
    write('src/view.ts', reads);

    // A spread copies an instance whole, reading every own field without
    // leaving a reference at any declaration.
    write('src/copy.ts', view('export const copy = (m: Mirror) => ({...m});'));
    clears('Mirror.stored', 'read through a spread of this class at');
    // A spread of something else says nothing about this class.
    write('src/copy.ts', 'const other = {stored: 1};\nexport const copy = () => ({...other});');
    fails('Mirror.stored', 'written but never read (1); remove it');
    // A spread of a subclass instance copies the fields it inherits, so the
    // base class's own field is read through it too.
    write(
      'src/copy.ts',
      'import {Mirror} from "./mirror";\nclass Wider extends Mirror {}\nexport const copy = () => ({...new Wider()});'
    );
    clears('Mirror.stored', 'read through a spread of this class at');
    // A method lives on the prototype and an accessor is not an own property,
    // so neither is copied by a spread of an instance.
    write('src/copy.ts', view('export const copy = (m: Mirror) => ({...m});'));
    write(
      'src/mirror.ts',
      'export class Mirror {\n  total(): number {\n    return 0;\n  }\n  spare(): number {\n    return 1;\n  }\n}'
    );
    fails('Mirror.spare', removeIt);
    write(
      'src/mirror.ts',
      'export class Mirror {\n  total(): number {\n    return 0;\n  }\n  get spare(): number {\n    return 1;\n  }\n}'
    );
    fails('Mirror.spare', 'nothing reads it; remove the getter');
    drop('src/copy.ts');

    // An accessor is reached by one kind of access, and a get/set pair shares
    // one symbol, so neither half may speak for the other.
    const pair =
      'export class Mirror {\n  private held = 0;\n  total(): number {\n    return this.held;\n  }\n  get value(): number {\n    return this.held;\n  }\n  set value(v: number) {\n    this.held = v;\n  }\n}';
    write('src/mirror.ts', pair);
    write('src/view.ts', view('export const show = (m: Mirror) => m.total() + m.value;'));
    fails('Mirror.value', 'nothing assigns it; remove the setter');
    write('src/view.ts', view('export const set = (m: Mirror) => {\n  m.value = m.total();\n};'));
    fails('Mirror.value', 'nothing reads it; remove the getter');
    write(
      'src/view.ts',
      view('export const use = (m: Mirror) => {\n  m.value = m.total();\n  return m.value;\n};')
    );
    passes();

    // TypeScript requires the halves of a pair to agree on visibility, so an
    // internal-only accessor cannot be narrowed on its own.
    write(
      'src/mirror.ts',
      'export class Mirror {\n  private held = 0;\n  get value(): number {\n    return this.held;\n  }\n  set value(v: number) {\n    this.held = v;\n  }\n  total(): number {\n    this.value = 1;\n    return this.value;\n  }\n}'
    );
    write('src/view.ts', reads);
    // Both halves are reported, each naming the access its own kind is missing.
    const pairResult = run();
    assert.equal(pairResult.status, 1, pairResult.stdout);
    assert.match(pairResult.stdout, /^Unused public class members \(2\)\n/u);
    const reported = pairResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('Mirror.value '));
    assert.equal(reported.length, 2, pairResult.stdout);
    assert.deepEqual(reported.map((line) => line.slice(line.indexOf(' - ') + 3)).sort(), [
      'assigned only inside its class (1); make the accessor pair private',
      'read only inside its class (1); make the accessor pair private',
    ]);
    write(
      'src/mirror.ts',
      'export class Mirror {\n  private held = 0;\n  get value(): number {\n    return this.held;\n  }\n  total(): number {\n    return this.value;\n  }\n}'
    );
    fails('Mirror.value', 'read only inside its class (1); make it private');

    // A data port needs no call signature: reading or assigning the member
    // through it is how a holder reaches it, which is how Ship.tapExtractFrames
    // is reached on the real tree.
    write('src/mirror.ts', stored);
    write(
      'src/host.ts',
      'export interface Host {\n  stored: number;\n  total(): number;\n}\nexport const bump = (h: Host) => {\n  h.stored += 1;\n};'
    );
    clears('Mirror.stored', 'declared by a type this class satisfies at');
    // The same port, never touched, reaches nothing.
    write(
      'src/host.ts',
      'export interface Host {\n  stored: number;\n  total(): number;\n}\nexport const hold = (h: Host) => h.total();'
    );
    fails('Mirror.stored', 'written but never read (1); remove it');
    drop('src/host.ts');

    // The language service reports one `isWriteAccess` boolean, and it is not
    // the complement of a read. A compound assignment and an increment both
    // READ the getter, so reporting it would have the author delete a getter
    // that `+=` still calls -- and TypeScript raises nothing when they do.
    write('src/mirror.ts', pair);
    for (const body of [
      'export const bump = (m: Mirror) => {\n  m.value += 1;\n};',
      'export const step = (m: Mirror) => {\n  m.value++;\n};',
      'export const back = (m: Mirror) => {\n  --m.value;\n};',
    ]) {
      write('src/view.ts', view(`${body}\nexport const show = (m: Mirror) => m.total();`));
      passes();
    }
    // A shorthand `{ value }` binds a local, so it reads the member and does
    // not assign it: the getter is reached and the setter is not.
    write(
      'src/view.ts',
      view(
        'export const show = (m: Mirror) => {\n  const { value } = m;\n  return value + m.total();\n};'
      )
    );
    fails('Mirror.value', 'nothing assigns it; remove the setter');
    // A renamed `{ value: v }` reads it too.
    write(
      'src/view.ts',
      view(
        'export const show = (m: Mirror) => {\n  const { value: v } = m;\n  return v + m.total();\n};'
      )
    );
    fails('Mirror.value', 'nothing assigns it; remove the setter');
    // The member on the right of a compound assignment is only read.
    write(
      'src/view.ts',
      view(
        'export const show = (m: Mirror) => {\n  let acc = 0;\n  acc += m.value;\n  return acc + m.total();\n};'
      )
    );
    fails('Mirror.value', 'nothing assigns it; remove the setter');

    // Every one of these ASSIGNS the setter. Recognising only the direct left
    // operand of a `=` reported each as unassigned, and the remedy does not
    // even compile: removing one half of a pair is TS2540 and removing a lone
    // setter is TS7053.
    for (const body of [
      'export const set = (m: Mirror) => {\n  m["value"] = m.total();\n};',
      'export const set = (m: Mirror) => {\n  (m.value) = m.total();\n};',
      'export const set = (m: Mirror) => {\n  ({ value: m.value } = { value: m.total() });\n};',
      'export const set = (m: Mirror) => {\n  [m.value] = [m.total()];\n};',
      'export const set = (m: Mirror) => {\n  for (m.value of [m.total()]) {\n    break;\n  }\n};',
    ]) {
      write('src/view.ts', view(body));
      fails('Mirror.value', 'nothing reads it; remove the getter');
    }

    // A field destructured off `this` is read, so the remedy is to narrow it
    // rather than to delete storage something still reads.
    write('src/view.ts', reads);
    write(
      'src/mirror.ts',
      'export class Mirror {\n  stored = 0;\n  total(): number {\n    this.stored = 2;\n    const { stored } = this;\n    return stored;\n  }\n}'
    );
    fails('Mirror.stored', makePrivate(2));

    // A public field written as a constructor parameter property is the same
    // field in another spelling, so the gate judges it the same way.
    write(
      'src/mirror.ts',
      'export class Mirror {\n  constructor(public spare: number) {}\n  total(): number {\n    return 0;\n  }\n}'
    );
    // Removing the parameter would break every construction site; what is
    // dead is the field its modifier declares.
    fails('Mirror.spare', 'nothing reads this parameter property; drop the modifier');
    write('src/view.ts', view('export const show = (m: Mirror) => m.total() + m.spare;'));
    passes();
    write('src/view.ts', reads);
    // A `private` one is Biome's, and a plain parameter is nobody's.
    write(
      'src/mirror.ts',
      'export class Mirror {\n  constructor(private spare: number, plain: number) {\n    this.spare = spare + plain;\n  }\n  total(): number {\n    return this.spare;\n  }\n}'
    );
    passes();

    // Kinds no gate of ours owns stay out of scope: Biome covers `private` and
    // `#private`, and a `protected` or `declare` member answers to nothing.
    write(
      'src/mirror.ts',
      'export class Mirror {\n  #hidden = 1;\n  protected guarded = 2;\n  declare ambient: number;\n  private own = 3;\n  total(): number {\n    return this.#hidden + this.own;\n  }\n}'
    );
    passes();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every kind the check judges is one it also recognises as a declaration', () => {
  // The two lists are maintained by hand, and divergence is silent AND
  // permissive in one direction: teach `checkableKind` a kind without teaching
  // `declaresMember`, and every such member's own declaration scores as a read,
  // so the member looks used and leaves the gate with no finding and no audit
  // line. That is how the object-literal kinds were missed.
  const source = readFileSync(new URL('./check-unused-class-members.mjs', import.meta.url), 'utf8');
  const body = (name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `cannot find ${name}`);
    const end = source.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `cannot delimit ${name}`);
    return source.slice(start, end);
  };
  const predicates = (name) =>
    new Set([...body(name).matchAll(/ts\.(is[A-Za-z]+)\(/gu)].map(([, shape]) => shape));
  const judged = predicates('checkableKind');
  const declares = predicates('declaresMember');
  // `isIdentifier` tests the NAME node rather than the member's kind, and
  // `isParameterPropertyDeclaration` refines `isParameter`, which is listed.
  const notKinds = new Set(['isIdentifier', 'isParameterPropertyDeclaration']);
  const missing = [...judged].filter((shape) => !notKinds.has(shape) && !declares.has(shape));
  assert.deepEqual(missing, [], `declaresMember is missing: ${missing.join(', ')}`);
  // The port and object-literal kinds are declarations only, so the reverse
  // containment must NOT hold -- an empty difference would mean the extraction
  // silently matched nothing.
  assert.ok([...declares].some((shape) => !judged.has(shape)));
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

test('the gate runs this check as a stage of its own', () => {
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts.scripts['check:members'], /check-unused-class-members\.mjs/u);
  // Chained behind the unused-export check, this one did not run at all when
  // that check failed, and its failures read as a ts-prune failure.
  assert.doesNotMatch(scripts.scripts['check:ts-prune'], /check-unused-class-members\.mjs/u);
  assert.ok(STAGES.some(([, command]) => command === 'check:members'));
});
