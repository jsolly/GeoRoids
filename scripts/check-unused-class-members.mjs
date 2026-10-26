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
 * Where a name could be reached from without naming the class, indexed by name
 * so adjudicating one member costs a few type queries instead of a scan. Each
 * entry is only a candidate: whether it actually reaches a given class is a
 * question for the type checker, asked once per reported member.
 */
function reachableWithoutTheClass(program, checker) {
  const declaringTypes = new Map();
  const inProbes = new Map();
  const keyArguments = new Map();
  const spreads = [];
  const add = (index, name, node) => {
    const nodes = index.get(name) ?? [];
    nodes.push(node);
    index.set(name, nodes);
  };
  for (const file of program.getSourceFiles()) {
    if (!owned(file)) {
      continue;
    }
    const visit = (node) => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name)) {
            add(declaringTypes, member.name.text, node);
          }
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isStringLiteralLike(node.left)
      ) {
        add(inProbes, node.left.text, node);
      }
      if (ts.isCallExpression(node)) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteralLike(argument)) {
            add(keyArguments, argument.text, argument);
          }
        }
      }
      if (ts.isSpreadAssignment(node)) {
        spreads.push(node);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  let resolved;
  return {
    declaringTypes,
    inProbes,
    keyArguments,
    // Resolving the spreads costs one type query each, so it is done once, and
    // only if a field actually needs adjudicating.
    spreadClasses: () => {
      resolved ??= spreadClasses(spreads, checker);
      return resolved;
    },
  };
}

/**
 * The classes whose instances are copied whole by an object spread, each mapped
 * to one such spread. `{...instance}` reads every own field without leaving a
 * reference at any of their declarations, so a field reached only that way
 * would otherwise be reported — and removing it would quietly empty the copy.
 */
function spreadClasses(spreads, checker) {
  const found = new Map();
  const note = (type, node) => {
    for (const part of type.isUnion() ? type.types : [type]) {
      for (const declaration of part.getSymbol()?.declarations ?? []) {
        if (ts.isClassLike(declaration) && !found.has(declaration)) {
          found.set(declaration, node);
        }
      }
      // A spread of a subclass instance copies the fields it inherits too.
      if (part.isClassOrInterface()) {
        for (const base of checker.getBaseTypes(part)) {
          note(base, node);
        }
      }
    }
  };
  for (const node of spreads) {
    note(checker.getTypeAtLocation(node.expression), node);
  }
  return found;
}

/**
 * Whether a string in this position names a key rather than carrying text. A
 * parameter typed `keyof T` resolves to a string literal or a union of them,
 * which is how `vi.spyOn(target, 'name')` reaches a member the service cannot
 * see; a plain `string` parameter is data and reaches nothing.
 */
function namesAKey(contextual) {
  if (contextual === undefined) {
    return false;
  }
  const parts = contextual.isUnion() ? contextual.types : [contextual];
  return parts.every((part) => part.isStringLiteral());
}

/**
 * Why a member with no reference of its own is still reachable, or undefined
 * when nothing reaches it. Every answer is a type relationship a caller could
 * actually use, rather than a matching name, and what counts depends on how
 * this kind of member is reached: by a call, by a read, by an assignment, or by
 * a copy of the whole instance. A base class needs no rule here:
 * the language service links a member to the base declaration it overrides, so
 * the reference pass has already cleared it.
 */
function reachedThroughType(name, kind, declaringClass, checker, service, index) {
  const classType = instanceType(declaringClass, checker);
  const where = (node) => {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    return `${source.fileName}:${line}`;
  };

  // A structural type this class satisfies declares it, so a caller holding
  // that port reaches the member without ever naming the class.
  for (const node of index.declaringTypes.get(name) ?? []) {
    const declared = ts.isInterfaceDeclaration(node)
      ? declaredTypeOf(node.name, checker)
      : checker.getTypeAtLocation(node);
    if (declared === undefined || !checker.isTypeAssignableTo(classType, declared)) {
      continue;
    }
    const declaredMember = declared.getProperty(name);
    if (declaredMember === undefined) {
      continue;
    }
    // The port has to be exercised: something must call, read or assign the
    // member through it. A declaration nothing ever touches reaches nothing,
    // which is why an interface written only to quiet this check does not.
    if (!isExercised(declaredMember, service)) {
      continue;
    }
    // A method is reached only by calling it, so a port that accepts one
    // without offering a call signature — a member typed `unknown`, or typed
    // as an empty interface — is not the channel that reaches it.
    if (kind === 'method') {
      const memberType = checker.getTypeOfSymbolAtLocation(declaredMember, node);
      if (memberType.getCallSignatures().length === 0) {
        continue;
      }
    }
    return `declared by a type this class satisfies at ${where(node)}`;
  }
  // `'name' in object`, where the object could be one of these.
  for (const node of index.inProbes.get(name) ?? []) {
    const probed = checker.getTypeAtLocation(node.right);
    // `unknown`, `any`, `object` and `{}` are assignable from every class, so
    // accepting them would make this a name match again. Only a counterparty
    // with a shape of its own says anything about this class.
    if (
      probed === undefined ||
      checker.getPropertiesOfType(probed).length === 0 ||
      !checker.isTypeAssignableTo(classType, probed)
    ) {
      continue;
    }
    return `probed with \`in\` at ${where(node)}`;
  }
  // Copied whole by a spread of this class, which reads fields but not methods:
  // a method lives on the prototype and an accessor is not an own property, so
  // neither is copied.
  if (kind === 'property') {
    const spread = index.spreadClasses().get(declaringClass);
    if (spread !== undefined) {
      return `read through a spread of this class at ${where(spread)}`;
    }
  }
  // A key of a related object, such as vi.spyOn(target, 'name').
  for (const node of index.keyArguments.get(name) ?? []) {
    if (!namesAKey(checker.getContextualType(node))) {
      continue;
    }
    const call = node.parent;
    if (!ts.isCallExpression(call)) {
      continue;
    }
    for (const sibling of call.arguments) {
      if (sibling === node) {
        continue;
      }
      const target = checker.getTypeAtLocation(sibling);
      if (target.getProperty(name) !== undefined && checker.isTypeAssignableTo(classType, target)) {
        return `named as a key of this class at ${where(node)}`;
      }
    }
  }
  return undefined;
}

/** Whether anything but its own declaration names this identifier. */
function isMentionedElsewhere(name, service) {
  const file = name.getSourceFile().fileName;
  const declaration = name.getStart();
  const references = service.getReferencesAtPosition(file, declaration) ?? [];
  return references.some(
    (reference) => reference.fileName !== file || reference.textSpan.start !== declaration
  );
}

/**
 * Whether anything touches this declared member through the type that declares
 * it. The question is asked of the port's own declaration, so a class that
 * satisfies an untouched shape is not cleared by it — including the shape of a
 * `Pick` or an extended interface, whose members resolve to the same symbol.
 */
function isExercised(member, service) {
  return (member.declarations ?? []).some(
    (declaration) =>
      declaration.name !== undefined &&
      ts.isIdentifier(declaration.name) &&
      isMentionedElsewhere(declaration.name, service)
  );
}

/** The type of an instance of this class, named or not. */
function instanceType(node, checker) {
  const declared = node.name === undefined ? undefined : declaredTypeOf(node.name, checker);
  if (declared !== undefined) {
    return declared;
  }
  const constructed = checker.getTypeAtLocation(node);
  const signatures = constructed.getConstructSignatures();
  return signatures.length > 0 ? signatures[0].getReturnType() : constructed;
}

function declaredTypeOf(name, checker) {
  const symbol = checker.getSymbolAtLocation(name);
  return symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
}

/**
 * Which kind of member this declaration is, or undefined for one this check
 * leaves alone. A `private` or `protected` member answers to Biome or to
 * nothing at all, and an overload signature, an abstract member and a `declare`
 * field each declare something another declaration implements. A field needs no
 * body, so only the kinds that have one are required to carry it.
 */
function checkableKind(member) {
  if (member.name === undefined || !ts.isIdentifier(member.name)) {
    return undefined;
  }
  const flags = ts.getCombinedModifierFlags(member);
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  const deferred = ts.ModifierFlags.Abstract | ts.ModifierFlags.Ambient | ts.ModifierFlags.Override;
  if ((flags & hidden) !== 0 || (flags & deferred) !== 0) {
    return undefined;
  }
  if (ts.isPropertyDeclaration(member)) {
    return 'property';
  }
  if (member.body === undefined) {
    return undefined;
  }
  if (ts.isMethodDeclaration(member)) {
    return 'method';
  }
  if (ts.isGetAccessor(member)) {
    return 'getter';
  }
  return ts.isSetAccessor(member) ? 'setter' : undefined;
}

/**
 * Whether a reference exercises this kind of member. A getter is reached by a
 * read and a setter by a write, and a get/set pair shares one symbol, so
 * judging either by every reference would let its partner speak for it.
 * Compound assignment reports as a write, which is the honest answer for a
 * field whose only use accumulates into it and nothing reads.
 */
function exercises(kind, reference) {
  if (kind === 'getter') {
    return reference.isWriteAccess !== true;
  }
  if (kind === 'setter') {
    return reference.isWriteAccess === true;
  }
  return true;
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

function remedy({ kind, internal, reads, componentOnly, paired }) {
  if (componentOnly) {
    return 'only a component calls it; cover the behavior from a test';
  }
  // An accessor is reached by one kind of access, so say which one is missing
  // rather than claiming nothing names it: its partner shares the name.
  if (internal === 0 && kind === 'getter') {
    return 'nothing reads it; remove the getter';
  }
  if (internal === 0 && kind === 'setter') {
    return 'nothing assigns it; remove the setter';
  }
  if (internal === 0) {
    return 'no TypeScript references; remove it';
  }
  // A field nothing reads is dead storage wherever it is written from, so
  // narrowing it to `private` would only move the finding to Biome.
  if (kind === 'property' && reads === 0) {
    return `written but never read (${internal}); remove it`;
  }
  const naming = { getter: 'read', setter: 'assigned' }[kind] ?? 'used';
  // TypeScript requires the two halves of a pair to agree on visibility.
  const how = paired ? 'make the accessor pair private' : 'make it private';
  return `${naming} only inside its class (${internal}); ${how}`;
}

/** Public production members no caller outside the declaring class reaches. */
function unusedClassMembers(root = process.cwd(), configName = 'config/typescript/prune.jsonc') {
  const service = languageService(root, configName);
  const program = service.getProgram();
  assert(program, 'Cannot build the unused-member program');
  const checker = program.getTypeChecker();
  // The relationship queries below are the whole point of this check, so a
  // TypeScript release that withdraws one has to fail it rather than quietly
  // return to matching names.
  assert(
    typeof checker.isTypeAssignableTo === 'function',
    'This TypeScript build cannot answer assignability, so reachability cannot be judged'
  );
  const index = reachableWithoutTheClass(program, checker);
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
  const cleared = [];
  for (const file of scanned) {
    const path = relative(root, file.fileName);
    const visit = (node) => {
      if (ts.isClassLike(node)) {
        const declared = declarationPositions(node, file);
        for (const member of node.members) {
          const kind = checkableKind(member);
          if (kind === undefined) {
            continue;
          }
          const name = member.name.text;
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
          const positions = declared.get(name) ?? new Set();
          // An overload signature and a get/set partner declare this member
          // rather than reaching it, as does its own declaration.
          const declares = (reference) =>
            reference.fileName === file.fileName && positions.has(reference.textSpan.start);
          const inside = (reference) =>
            reference.fileName === file.fileName &&
            reference.textSpan.start >= node.getStart(file) &&
            reference.textSpan.start < node.getEnd();
          const uses = references.filter(
            (reference) => !declares(reference) && exercises(kind, reference)
          );
          if (uses.some((reference) => !inside(reference))) {
            continue;
          }
          const reason = reachedThroughType(name, kind, node, checker, service, index);
          if (reason !== undefined) {
            cleared.push({
              member: `${node.name?.text ?? '(anonymous)'}.${name}`,
              path,
              line: file.getLineAndCharacterOfPosition(declaration).line + 1,
              reason: reason.split(`${root}${sep}`).join(''),
            });
            continue;
          }
          findings.push({
            member: `${node.name?.text ?? '(anonymous)'}.${name}`,
            path,
            line: file.getLineAndCharacterOfPosition(declaration).line + 1,
            kind,
            // Overload signatures repeat a name as well, so the partner has
            // to be identified by kind rather than by name alone.
            paired: node.members.some(
              (other) =>
                other !== member &&
                other.name !== undefined &&
                ts.isIdentifier(other.name) &&
                other.name.text === name &&
                (ts.isGetAccessor(other) || ts.isSetAccessor(other))
            ),
            internal: uses.length,
            reads: references.filter(
              (reference) => !declares(reference) && reference.isWriteAccess !== true
            ).length,
            componentOnly: (fromComponents.get(moduleKey(file.fileName)) ?? new Set()).has(name),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return { findings, cleared };
}

export function checkUnusedClassMembers(root = process.cwd(), configName) {
  const { findings, cleared } = unusedClassMembers(root, configName);
  const report = findings.map(
    (finding) => `${finding.member} ${finding.path}:${finding.line} - ${remedy(finding)}\n`
  );
  // Each member kept without a reference of its own says which relationship
  // kept it, so a run that reports nothing can be audited rather than trusted.
  const audit = cleared.map(
    ({ member, path, line, reason }) => `${member} ${path}:${line} - ${reason}\n`
  );
  const problems =
    findings.length === 0
      ? ''
      : `Unused public class members (${findings.length})\n${report.join('')}`;
  const kept =
    cleared.length === 0
      ? ''
      : `${problems === '' ? '' : '\n'}Reachable only through a type relationship (${cleared.length})\n${audit.join('')}`;
  return { status: findings.length === 0 ? 0 : 1, stdout: problems + kept };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = checkUnusedClassMembers();
  process.stdout.write(result.stdout);
  process.exitCode = result.status;
}
