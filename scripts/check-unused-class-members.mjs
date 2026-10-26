import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseAstro } from '@astrojs/compiler-rs';
import { parse as parseSvelte } from 'svelte/compiler';
import ts from 'typescript';
import { components } from './check-unused-typescript.mjs';

// Knip reports unused module exports and Biome reports unused private members,
// so a public member that nothing outside its own class reaches belongs to
// neither gate. Production classes own the authoritative simulation; test
// doubles, benchmark harnesses and shims under scripts/ exist to satisfy
// external shapes such as WebSocket, so their members stay out of scope.
const productionDirectories = ['src', 'server', 'shared'];

const owned = (file) => !file.isDeclarationFile && !file.fileName.includes('node_modules');

const moduleKey = (path) => path.replace(/\.[^./\\]+$/u, '');

function isProduction(path) {
  return productionDirectories.some((directory) => path.startsWith(`${directory}${sep}`));
}

function languageService(root, configName) {
  const configPath = resolve(root, configName);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert(!config.error, 'Cannot read the unused-member configuration');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  // A rejected glob or compiler option would otherwise yield a small program and
  // a clean report, so a configuration that did not parse fails the check here.
  assert.deepEqual(
    parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, ' ')),
    [],
    'The unused-member configuration did not parse'
  );
  const snapshots = new Map();
  const host = {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => {
      if (!snapshots.has(name)) {
        const text = ts.sys.readFile(name);
        snapshots.set(name, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
      }
      return snapshots.get(name);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/**
 * Member names each module's component callers reach, keyed by the module they
 * import. The TypeScript program holds no `.svelte` or `.astro` file, so a
 * method only a component calls has no reference the service can find. Keying
 * by import matters: components touch DOM and standard-library members named
 * `close`, `clear`, `filter` and `show`, which must not speak for an unrelated
 * class — and a component can never reach `server/` or `shared/` at all.
 * Markup counts, because two of `WikiScrollMemory`'s ten public methods are
 * reached only from outside its script block.
 */
function componentMembers(root) {
  const reached = new Map();
  for (const path of components(join(root, 'src'))) {
    const source = readFileSync(path, 'utf8');
    const names = new Set();
    const imported = new Set();
    const visit = (node) => {
      if (node === null || typeof node !== 'object') {
        return;
      }
      if (node.type === 'MemberExpression' && node.property?.type === 'Identifier') {
        names.add(node.property.name);
      }
      if (
        node.type === 'ImportDeclaration' &&
        typeof node.source?.value === 'string' &&
        node.source.value.startsWith('.')
      ) {
        imported.add(moduleKey(resolve(dirname(path), node.source.value)));
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          value.forEach(visit);
        } else {
          visit(value);
        }
      }
    };
    visit(
      path.endsWith('.svelte') ? parseSvelte(source, { modern: true }) : parseAstro(source).ast
    );
    for (const module of imported) {
      const already = reached.get(module) ?? new Set();
      for (const name of names) {
        already.add(name);
      }
      reached.set(module, already);
    }
  }
  return reached;
}

/**
 * Names a caller can reach without naming the class: members declared by an
 * interface or object type, the operand of an `in` probe, and a string argument
 * such as `vi.spyOn(target, 'name')`. Bracket access needs no entry, because
 * the service resolves `object['name']()` by itself. Plus the classes other
 * declarations extend, whose members answer to their own contract.
 */
function reachableWithoutTheClass(program) {
  const contracts = new Set();
  const literals = new Set();
  const bases = new Set();
  for (const file of program.getSourceFiles()) {
    if (!owned(file)) {
      continue;
    }
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name)) {
            contracts.add(member.name.text);
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isStringLiteralLike(node.left)
      ) {
        literals.add(node.left.text);
      }
      if (ts.isCallExpression(node)) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteralLike(argument)) {
            literals.add(argument.text);
          }
        }
      }
      for (const clause of ts.isClassLike(node) ? (node.heritageClauses ?? []) : []) {
        for (const type of clause.types) {
          if (ts.isIdentifier(type.expression)) {
            bases.add(type.expression.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return { contracts, literals, bases };
}

/**
 * Classes whose members this check can judge. A class in a hierarchy, or one a
 * structural port stands in for, is reached through types this check does not
 * follow, so its members stay out of scope.
 */
function isCheckableClass(node, bases) {
  return (
    (node.heritageClauses?.length ?? 0) === 0 &&
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract) === 0 &&
    (node.name === undefined || !bases.has(node.name.text))
  );
}

function isCheckableMember(member) {
  if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
    return false;
  }
  const flags = ts.getCombinedModifierFlags(member);
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  const deferred = ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient | ts.ModifierFlags.Override;
  return (flags & hidden) === 0 && (flags & deferred) === 0 && member.body !== undefined;
}

/**
 * Where this class declares each name. Overload signatures declare the same
 * member rather than using it, and the service does not reliably flag a
 * declaration, so every declared position is located once per class.
 */
function declarationPositions(node, file) {
  const positions = new Map();
  for (const member of node.members) {
    if (member.name === undefined || !ts.isIdentifier(member.name)) {
      continue;
    }
    const declared = positions.get(member.name.text) ?? new Set();
    declared.add(member.name.getStart(file));
    positions.set(member.name.text, declared);
  }
  return positions;
}

function remedy(internal, componentOnly) {
  if (componentOnly) {
    return 'only a component calls it; cover the behavior from a test';
  }
  return internal > 0
    ? `used only inside its class (${internal}); make it private`
    : 'no TypeScript references; remove it';
}

/** Public production methods no caller outside the declaring class reaches. */
function unusedClassMembers(root = process.cwd(), configName = 'config/typescript/prune.jsonc') {
  const service = languageService(root, configName);
  const program = service.getProgram();
  assert(program, 'Cannot build the unused-member program');
  const { contracts, literals, bases } = reachableWithoutTheClass(program);
  const fromComponents = componentMembers(root);
  const scanned = program
    .getSourceFiles()
    .filter((file) => owned(file) && isProduction(relative(root, file.fileName)));
  // A mistyped or narrowed glob drops a whole directory without a configuration
  // error, because TypeScript only reports an empty program. Every directory
  // has to contribute, or a clean run says nothing about the rest.
  assert.deepEqual(
    productionDirectories.filter(
      (directory) =>
        !scanned.some((file) => relative(root, file.fileName).startsWith(`${directory}${sep}`))
    ),
    [],
    'The unused-member program resolved no production files under these directories'
  );
  const findings = [];
  for (const file of scanned) {
    const path = relative(root, file.fileName);
    const visit = (node) => {
      if (ts.isClassLike(node) && isCheckableClass(node, bases)) {
        const declared = declarationPositions(node, file);
        for (const member of node.members) {
          if (!isCheckableMember(member)) {
            continue;
          }
          const name = member.name.text;
          if (contracts.has(name) || literals.has(name)) {
            continue;
          }
          const declaration = member.name.getStart(file);
          const references = service.getReferencesAtPosition(file.fileName, declaration) ?? [];
          // A dead member still reports its own declaration, so nothing at all
          // is a failed lookup rather than a verdict about the code.
          assert(
            references.some(
              (reference) =>
                reference.fileName === file.fileName && reference.textSpan.start === declaration
            ),
            `Cannot resolve references for ${name} in ${path}`
          );
          const inside = (reference) =>
            reference.fileName === file.fileName &&
            reference.textSpan.start >= node.getStart(file) &&
            reference.textSpan.start < node.getEnd();
          if (references.some((reference) => !inside(reference))) {
            continue;
          }
          const positions = declared.get(name) ?? new Set();
          findings.push({
            member: `${node.name?.text ?? '(anonymous)'}.${name}`,
            path,
            line: file.getLineAndCharacterOfPosition(declaration).line + 1,
            internal: references.filter(
              (reference) => inside(reference) && !positions.has(reference.textSpan.start)
            ).length,
            componentOnly: (fromComponents.get(moduleKey(file.fileName)) ?? new Set()).has(name),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return findings;
}

export function checkUnusedClassMembers(root = process.cwd(), configName) {
  const findings = unusedClassMembers(root, configName);
  const report = findings.map(
    ({ member, path, line, internal, componentOnly }) =>
      `${member} ${path}:${line} - ${remedy(internal, componentOnly)}\n`
  );
  return {
    status: findings.length === 0 ? 0 : 1,
    stdout:
      findings.length === 0
        ? ''
        : `Unused public class members (${findings.length})\n${report.join('')}`,
  };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = checkUnusedClassMembers();
  process.stdout.write(result.stdout);
  process.exitCode = result.status;
}
