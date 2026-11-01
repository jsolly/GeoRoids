import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseAstro } from '@astrojs/compiler-rs';
import { parse as parseSvelte } from 'svelte/compiler';
import ts from 'typescript';

const componentExtension = /\.(?:svelte|astro)$/u;
const nonTypescriptExtension = /\.(?:svelte|astro|css)$/u;

/** Component files, enumerated once for both unused-code gates. */
export function components(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? components(path) : componentExtension.test(path) ? [path] : [];
  });
}
function declarations(path: string): unknown[] {
  const source = readFileSync(path, 'utf8');
  if (path.endsWith('.svelte')) {
    const ast = parseSvelte(source, { modern: true });
    return [...(ast.instance?.content.body ?? []), ...(ast.module?.content.body ?? [])];
  }
  const parsed = parseAstro(source);
  assert(
    !parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    `Cannot parse ${path}`
  );
  const imports: unknown[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    if ('type' in node && node.type === 'ImportDeclaration') {
      imports.push(node);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else {
        visit(value);
      }
    }
  };
  visit(parsed.ast);
  return imports;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Entry imports are compiler-parsed; strict frontend diagnostics enforce their use. */
export function frontendEntry(root: string): string {
  const lines: string[] = [];
  let serial = 0;
  for (const component of components(join(root, 'src'))) {
    for (const declaration of declarations(component)) {
      if (!isRecord(declaration) || declaration['type'] !== 'ImportDeclaration') {
        continue;
      }
      const source = declaration['source'];
      assert(
        isRecord(source) && typeof source['value'] === 'string',
        `Unsupported frontend import in ${component}`
      );
      const moduleName = source['value'];
      if (!moduleName.startsWith('.')) {
        continue;
      }
      const module = resolve(dirname(component), moduleName);
      if (nonTypescriptExtension.test(module)) {
        continue;
      }
      const resolvedModule = ts.resolveModuleName(
        moduleName,
        component,
        { moduleResolution: ts.ModuleResolutionKind.Bundler },
        ts.sys
      ).resolvedModule?.resolvedFileName;
      assert(
        resolvedModule,
        `Cannot resolve frontend TypeScript import in ${component}: ${moduleName}`
      );
      const rawSpecifiers = declaration['specifiers'];
      assert(Array.isArray(rawSpecifiers), `Unsupported frontend import in ${component}`);
      const specifiers: readonly unknown[] = rawSpecifiers;
      for (const specifier of specifiers) {
        assert(isRecord(specifier), `Unsupported frontend import in ${component}`);
        assert(
          specifier['type'] !== 'ImportNamespaceSpecifier',
          `Use named imports for frontend TypeScript exports: ${component}`
        );
        const alias = `frontendImport${serial++}`;
        let imported: unknown;
        if (specifier['type'] === 'ImportDefaultSpecifier') {
          imported = 'default';
        } else {
          const identifier = specifier['imported'];
          assert(isRecord(identifier), `Unsupported frontend import in ${component}`);
          imported = identifier['name'];
        }
        assert(typeof imported === 'string', `Unsupported frontend import in ${component}`);
        const type = declaration['importKind'] === 'type' || specifier['importKind'] === 'type';
        lines.push(
          `import ${type ? 'type ' : ''}{ ${imported} as ${alias} } from ${JSON.stringify(resolvedModule)};`
        );
        lines.push(
          type
            ? `let reference${serial}!: ${alias}; console.log(reference${serial});`
            : `console.log(${alias});`
        );
      }
    }
  }
  // The tools consume defaults; named exports still need real callers.
  for (const config of [
    'config/app/astro.ts',
    'config/testing/tooling.ts',
    'config/testing/vitest.ts',
  ]) {
    const path = join(root, config);
    if (existsSync(path)) {
      const alias = `toolConfig${serial++}`;
      lines.push(`import ${alias} from ${JSON.stringify(path)}; console.log(${alias});`);
    }
  }
  // Astro invokes this exact framework export; other content-config exports remain checked.
  const contentConfig = join(root, 'src/content.config.ts');
  if (existsSync(contentConfig)) {
    lines.push(
      `import { collections } from ${JSON.stringify(contentConfig)}; console.log(collections);`
    );
  }
  return `${lines.join('\n')}\n`;
}

export function checkUnusedTypescript(
  root = process.cwd(),
  configName = 'config/typescript/prune.jsonc'
) {
  const configPath = resolve(root, configName);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert(!config.error, 'Cannot read ts-prune configuration');
  const rawConfig: unknown = config.config;
  assert(isRecord(rawConfig), 'Cannot read ts-prune configuration');
  const parsed = ts.parseJsonConfigFileContent(rawConfig, ts.sys, dirname(configPath));
  assert(parsed.options.noUnusedLocals, 'Frontend unused import proof requires noUnusedLocals');
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'georoids-frontend-prune-')));
  try {
    const entry = join(temporary, 'frontend-entry.ts');
    writeFileSync(entry, frontendEntry(root));
    const project = join(temporary, 'tsconfig.json');
    const configuredFiles = rawConfig['files'] ?? [];
    assert(Array.isArray(configuredFiles), 'Invalid ts-prune files list');
    writeFileSync(
      project,
      JSON.stringify({
        extends: configPath,
        files: [
          ...configuredFiles.map((path: unknown) => {
            assert(typeof path === 'string', 'Invalid ts-prune file path');
            return relative(temporary, resolve(dirname(configPath), path));
          }),
          'frontend-entry.ts',
        ],
      })
    );
    return spawnSync(
      process.execPath,
      [resolve('node_modules/.bin/ts-prune'), '--error', '--project', 'tsconfig.json'],
      { cwd: temporary, encoding: 'utf8', timeout: 120000 }
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = checkUnusedTypescript();
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
