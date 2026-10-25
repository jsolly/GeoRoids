import assert from 'node:assert/strict';
import { dirname, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Knip reports unused module exports and Biome reports unused private members,
// so a public member that nothing outside its own class reaches belongs to
// neither gate. Production classes own the authoritative simulation; test
// doubles, benchmark harnesses and shims under scripts/ exist to satisfy
// external shapes such as WebSocket, so their members stay out of scope.
const productionDirectories = ['src', 'server', 'shared'];

const owned = (file) => !file.isDeclarationFile && !file.fileName.includes('node_modules');

function isProduction(path) {
  return productionDirectories.some((directory) => path.startsWith(`${directory}${sep}`));
}

function languageService(root, configName) {
  const configPath = resolve(root, configName);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert(!config.error, 'Cannot read the unused-member configuration');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
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
 * Names a caller can reach without naming the class: members declared by an
 * interface or object type, every string literal (bracket access, `in` probes
 * and `vi.spyOn(target, 'name')`), and the classes other declarations extend.
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
      if (ts.isStringLiteralLike(node)) {
        literals.add(node.text);
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

function isCheckable(member) {
  if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) {
    return false;
  }
  const flags = ts.getCombinedModifierFlags(member);
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  const deferred = ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient | ts.ModifierFlags.Override;
  return (flags & hidden) === 0 && (flags & deferred) === 0 && member.body !== undefined;
}

/** Public production methods no caller outside the declaring class reaches. */
function unusedClassMembers(root = process.cwd(), configName = 'config/typescript/prune.jsonc') {
  const service = languageService(root, configName);
  const program = service.getProgram();
  assert(program, 'Cannot build the unused-member program');
  const { contracts, literals, bases } = reachableWithoutTheClass(program);
  const findings = [];
  for (const file of program.getSourceFiles()) {
    if (!owned(file)) {
      continue;
    }
    const path = relative(root, file.fileName);
    if (!isProduction(path)) {
      continue;
    }
    const visit = (node) => {
      const skipped =
        !ts.isClassDeclaration(node) ||
        (node.heritageClauses?.length ?? 0) > 0 ||
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract) !== 0 ||
        (node.name !== undefined && bases.has(node.name.text));
      for (const member of skipped ? [] : node.members) {
        if (!isCheckable(member)) {
          continue;
        }
        const name = member.name.getText(file);
        if (contracts.has(name) || literals.has(name)) {
          continue;
        }
        const declaration = member.name.getStart(file);
        const references = service.getReferencesAtPosition(file.fileName, declaration) ?? [];
        const inside = (reference) =>
          reference.fileName === file.fileName &&
          reference.textSpan.start >= node.getStart(file) &&
          reference.textSpan.start < node.getEnd();
        if (references.some((reference) => !inside(reference))) {
          continue;
        }
        findings.push({
          member: `${node.name?.text ?? '(anonymous)'}.${name}`,
          path,
          line: file.getLineAndCharacterOfPosition(declaration).line + 1,
          internal: references.filter(
            (reference) => inside(reference) && reference.textSpan.start !== declaration
          ).length,
        });
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
    ({ member, path, line, internal }) =>
      `${member} ${path}:${line} - ${internal === 0 ? 'no references; remove it' : `used only inside its class (${internal}); make it private`}\n`
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
