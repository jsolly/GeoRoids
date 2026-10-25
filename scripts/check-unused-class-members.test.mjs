import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { checkUnusedClassMembers } from './check-unused-class-members.mjs';

test('public production methods need a caller outside their own class', () => {
  const root = mkdtempSync(join(tmpdir(), 'georoids-class-member-contract-'));
  const write = (path, body) => writeFileSync(join(root, path), body);
  const run = () => checkUnusedClassMembers(root);
  const passes = () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout);
  };
  const fails = (name, remedy) => {
    const result = run();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, new RegExp(name, 'u'));
    assert.match(result.stdout, new RegExp(remedy, 'u'));
  };
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
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
        include: ['../../src/**/*.ts', '../../tests/**/*.ts'],
      })
    );
    const engine = (members) => `export class Engine {\n${members}\n}`;
    const live = '  step(): number {\n    return 1;\n  }';
    write('src/engine.ts', engine(live));
    write('src/main.ts', 'import {Engine} from "./engine"; console.log(new Engine().step());');
    passes();

    // A method nothing reaches at all, and one only its own class reaches.
    write('src/engine.ts', engine(`${live}\n  orphan(): number {\n    return 2;\n  }`));
    fails('Engine\\.orphan', 'no references; remove it');
    write(
      'src/engine.ts',
      engine(`${live}\n  helper(): number {\n    return this.step();\n  }\n
  inner(): number {\n    return this.helper();\n  }`)
    );
    fails('Engine\\.inner', 'no references; remove it');

    // A caller outside the class clears the member, through any of the ways a
    // caller can reach it without naming the class.
    write('src/engine.ts', engine(`${live}\n  reached(): number {\n    return 3;\n  }`));
    write(
      'src/main.ts',
      'import {Engine} from "./engine"; const e = new Engine(); console.log(e.step(), e.reached());'
    );
    passes();
    write('tests/engine.test.ts', 'import {Engine} from "../src/engine"; new Engine().step();');
    write('src/main.ts', 'import {Engine} from "./engine"; console.log(new Engine().step());');
    fails('Engine\\.reached', 'no references; remove it');
    write('src/port.ts', 'export interface Port {\n  reached(): number;\n}');
    passes();
    rmSync(join(root, 'src/port.ts'));
    fails('Engine\\.reached', 'no references; remove it');
    write('src/probe.ts', 'export const probe = (v: object) => "reached" in v;');
    passes();
    rmSync(join(root, 'src/probe.ts'));

    // Subclassing, heritage and abstract members defer to their own contract.
    write('src/sub.ts', 'import {Engine} from "./engine"; export class Sub extends Engine {}');
    passes();
    rmSync(join(root, 'src/sub.ts'));
    fails('Engine\\.reached', 'no references; remove it');

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
    fails('Engine\\.widened', 'make it private');

    // Test doubles and other non-production classes stay out of scope.
    write('src/engine.ts', engine(live));
    write(
      'tests/engine.test.ts',
      'import {Engine} from "../src/engine";\nexport class FakeSocket {\n  send(): void {}\n}\nnew Engine().step();'
    );
    passes();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
