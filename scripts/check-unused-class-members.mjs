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
 * Where a name could be reached from without naming the class. The first three
 * indexes are keyed by name so adjudicating one member costs a few type
 * queries instead of a scan, and each of their entries is only a candidate:
 * whether it actually reaches a given class is a question for the type
 * checker, asked once per reported member. `spreadClasses` is the exception
 * and the reason this takes a `checker` — a spread names no member, so it is
 * keyed by the class declaration it copies and already holds the answer.
 */
function reachableWithoutTheClass(program, checker) {
  const declaringTypes = new Map();
  const inProbes = new Map();
  const keyArguments = new Map();
  const spreadClasses = new Map();
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
        noteSpread(spreadClasses, checker.getTypeAtLocation(node.expression), node, checker);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return { declaringTypes, inProbes, keyArguments, spreadClasses };
}

/**
 * Record the classes whose instances this object spread copies whole.
 * `{...instance}` reads every own field without leaving a reference at any of
 * their declarations, so a field reached only that way would otherwise be
 * reported — and removing it would quietly empty the copy.
 */
function noteSpread(found, type, node, checker) {
  for (const part of type.isUnion() ? type.types : [type]) {
    for (const declaration of part.getSymbol()?.declarations ?? []) {
      if (ts.isClassLike(declaration) && !found.has(declaration)) {
        found.set(declaration, node);
      }
    }
    // A spread of a subclass instance copies the fields it inherits too.
    if (part.isClassOrInterface()) {
      for (const base of checker.getBaseTypes(part)) {
        noteSpread(found, base, node, checker);
      }
    }
  }
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
 * a copy of the whole instance. A base class or an implemented interface needs
 * no rule here, but not because the reference pass cleared it: its declaration
 * is not a use (see `accessKind`), so such a member arrives here and must earn
 * its clearance like any other.
 */
function reachedThroughType(name, kind, declaringClass, checker, service, program, index) {
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
    if (!isExercised(declaredMember, service, program)) {
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
    const spread = index.spreadClasses.get(declaringClass);
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

/**
 * Whether anything touches this declared member through the type that declares
 * it. Only a read, a write or a call counts: another declaration of the same
 * name is not a caller, so neither an overload signature nor a class that
 * implements the port can stand in for one. A `Pick` or an extended interface
 * resolves to the same symbol, so an exercised port still clears through them.
 */
function isExercised(member, service, program) {
  return (member.declarations ?? []).some((declaration) => {
    if (declaration.name === undefined || !ts.isIdentifier(declaration.name)) {
      return false;
    }
    const file = declaration.getSourceFile().fileName;
    const references = service.getReferencesAtPosition(file, declaration.name.getStart()) ?? [];
    // An access must actually touch the member. `!== 'declaration'` also admitted
    // `'unresolved'`, so a port named only by a doc comment or an indexed-access
    // type counted as exercised and cleared a member with an audit line claiming
    // a relationship nothing uses.
    return references.some((reference) => {
      const access = accessKind(reference, program);
      return access === 'read' || access === 'write' || access === 'readwrite';
    });
  });
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
 * nothing at all, and an overload signature, an abstract member, a `declare`
 * field and an `override` member each declare something another declaration
 * owns. A field needs no body, so only the kinds that have one must carry one.
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
  // `constructor(public spare: number)` declares a public field outside the
  // class body, so the gate would otherwise cover one spelling and not the other.
  if (ts.isParameter(member)) {
    return ts.isParameterPropertyDeclaration(member, member.parent) ? 'property' : undefined;
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
 * The name node a reference points at. A dotted access lands on an identifier
 * and a bracket access on the string literal that spells the key, so both are
 * resolvable; a `{@link C.m}` doc comment is not, because `forEachChild` does
 * not descend into JSDoc, and an unresolved reference is deliberately not
 * treated as a use.
 */
function nameAt(source, position) {
  let found;
  const visit = (node) => {
    if (node.getStart(source) > position || node.getEnd() < position) {
      return;
    }
    if (ts.isIdentifier(node) && node.getStart(source) === position) {
      found = node;
    }
    // A bracket key is reported at the name inside the quotes, one past the
    // literal's own start.
    if (ts.isStringLiteralLike(node) && node.getStart(source) + 1 === position) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** The expression a reference reaches the member through, such as `m.value`. */
function accessExpression(name) {
  const parent = name.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === name) {
    return parent;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === name) {
    return parent;
  }
  return name;
}

/**
 * The node whose parent decides how this access is used, looking through the
 * wrappers that do not change that: `(m.value) = 1` assigns through
 * parentheses, and `m.value! = 1` through a non-null assertion.
 */
function enclosing(access) {
  let node = access;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isNonNullExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isTypeAssertionExpression(node.parent) ||
    ts.isSatisfiesExpression(node.parent)
  ) {
    node = node.parent;
  }
  return node;
}

/**
 * Whether an assignment writes to this access. `m.value = 1` is the direct
 * case; a destructuring pattern reaches the same write through an array or
 * object literal standing on the left of the `=`, and `for (m.value of …)`
 * through the loop's own initializer. Missing any of those spellings reports a
 * setter that is in fact assigned, and the remedy would not compile.
 */
function assigns(access) {
  const node = enclosing(access);
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) {
    return parent.initializer === node;
  }
  if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) {
    return assigns(parent);
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    return assigns(parent.parent);
  }
  return false;
}

/** Whether a compound assignment both reads and writes this access. */
function updates(access) {
  const node = enclosing(access);
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const operator = parent.operatorToken.kind;
    return operator > ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
  }
  const increment = ts.SyntaxKind.PlusPlusToken;
  const decrement = ts.SyntaxKind.MinusMinusToken;
  return (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === node &&
    (parent.operator === increment || parent.operator === decrement)
  );
}

/**
 * Whether this reference names the member inside a type rather than using it.
 * `ReturnType<RoidBelt['getRoids']>` depends on the member's type and calls
 * nothing, so it cannot keep an otherwise dead member alive.
 */
function namesAType(name) {
  return ts.isLiteralTypeNode(name.parent) && ts.isIndexedAccessTypeNode(name.parent.parent);
}

/**
 * How a reference touches the member. The language service reports a single
 * `isWriteAccess` boolean, and it is not the complement of a read: a compound
 * assignment and `++` both read and write, and a shorthand `{ value }` pattern
 * writes a new local rather than the member, so it only reads. Accessors are
 * judged by this answer, so collapsing it to a boolean reports a getter that a
 * `+=` still calls. The shape of the syntax decides it instead, and a shape
 * this cannot resolve answers `unresolved`, which reaches nothing: a default of
 * `read` would let a doc comment or a type alias retire a member silently, and
 * a gate that cannot tell must report rather than clear.
 */
function accessKind(reference, program) {
  const source = program.getSourceFile(reference.fileName);
  const name = source === undefined ? undefined : nameAt(source, reference.textSpan.start);
  if (name === undefined) {
    return 'unresolved';
  }
  // A base class's or an interface's own declaration comes back among a
  // member's references, an overload signature repeats one, and an object
  // literal that satisfies a port declares the member rather than using it, so
  // counting any of those as uses lets a shape stand in for a caller.
  if (declaresMember(name)) {
    return 'declaration';
  }
  if (namesAType(name)) {
    return 'unresolved';
  }
  const access = accessExpression(name);
  if (assigns(access)) {
    return 'write';
  }
  if (updates(access)) {
    return 'readwrite';
  }
  // Everything else reads, including `{ value }` and `{ value: v }`, which bind
  // a local rather than assigning the member — the one case `isWriteAccess`
  // reports as a write although nothing is written.
  return 'read';
}

/**
 * Whether this member is public and answers to no gate because its name is not
 * an identifier. A `#private` name is Biome's. A string, computed or numeric
 * one has no owner, so the run names it instead of passing it in silence.
 */
function unjudgedName(member) {
  if (
    member.name === undefined ||
    ts.isIdentifier(member.name) ||
    ts.isPrivateIdentifier(member.name)
  ) {
    return false;
  }
  const spokenFor =
    ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected |
    ts.ModifierFlags.Abstract |
    ts.ModifierFlags.Ambient |
    ts.ModifierFlags.Override;
  return (ts.getCombinedModifierFlags(member) & spokenFor) === 0;
}

/**
 * Whether this identifier is a member declaration's own name. Every kind
 * `checkableKind` judges belongs here, plus the signature kinds a port is
 * written with and the object-literal kinds a port is satisfied with;
 * `scripts/check-unused-class-members.test.mjs` pins that parity, because a
 * kind missing from this list is counted as a use and retires its member
 * silently. A `BindingElement` is deliberately absent: `const { value } = m`
 * declares a local and reads the member.
 */
function declaresMember(name) {
  const parent = name.parent;
  if (parent.name !== name) {
    return false;
  }
  // An object literal that satisfies a port declares the member, but the same
  // syntax standing where an assignment lands is a destructuring target, and
  // there the key READS the member: `({ value } = store)` calls the getter.
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
    return !assigns(parent.parent);
  }
  return (
    ts.isPropertySignature(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isGetAccessor(parent) ||
    ts.isSetAccessor(parent) ||
    ts.isParameter(parent)
  );
}

/**
 * Whether an access of this kind reaches this kind of member. A get/set pair
 * shares one symbol, so judging either by every reference would let its partner
 * speak for it: a `+=` reaches both halves, a plain read only the getter, and a
 * destructure only the getter.
 */
function reaches(kind, access) {
  if (access === 'declaration' || access === 'unresolved') {
    return false;
  }
  if (kind === 'getter') {
    return access === 'read' || access === 'readwrite';
  }
  if (kind === 'setter') {
    return access === 'write' || access === 'readwrite';
  }
  return true;
}

function remedy({ kind, internal, reads, componentOnly, paired, parameter, unresolved }) {
  if (componentOnly) {
    return 'only a component reaches it; cover the behavior from a test';
  }
  // An accessor is reached by one kind of access, so say which one is missing
  // rather than claiming nothing names it: its partner shares the name.
  if (internal === 0 && kind === 'getter') {
    return 'nothing reads it; remove the getter';
  }
  if (internal === 0 && kind === 'setter') {
    return 'nothing assigns it; remove the setter';
  }
  // Every construction site passes a constructor parameter, so removing it
  // breaks each caller (TS2554). What is dead is the field the modifier
  // declares, whether or not the class also writes it.
  if (reads === 0 && parameter) {
    return 'nothing reads this parameter property; drop the modifier';
  }
  // A reference the check could not classify is still a reference: saying
  // there are none sends the author to delete a member a type position or a
  // doc comment still names, which does not compile (TS2339).
  if (internal === 0 && unresolved > 0) {
    return 'named only by a type or doc reference this check cannot classify; confirm by hand';
  }
  if (internal === 0) {
    return 'no TypeScript references; remove it';
  }
  // A field nothing reads is dead storage wherever it is written from, so
  // narrowing it to `private` would only move the finding to Biome.
  if (kind === 'property' && reads === 0) {
    return unresolved > 0
      ? `written but never read (${internal}), and named by a reference this check cannot classify; confirm by hand`
      : `written but never read (${internal}); remove it`;
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
  const unjudged = [];
  for (const file of scanned) {
    const path = relative(root, file.fileName);
    const visit = (node) => {
      if (ts.isClassLike(node)) {
        const judged = node.members.flatMap((member) =>
          ts.isConstructorDeclaration(member) ? [...member.parameters] : [member]
        );
        for (const member of judged) {
          const kind = checkableKind(member);
          if (kind === undefined) {
            if (unjudgedName(member)) {
              unjudged.push({
                member: `${node.name?.text ?? '(anonymous)'}.${member.name.getText(file)}`,
                path,
                line: file.getLineAndCharacterOfPosition(member.name.getStart(file)).line + 1,
              });
            }
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
          const inside = (reference) =>
            reference.fileName === file.fileName &&
            reference.textSpan.start >= node.getStart(file) &&
            reference.textSpan.start < node.getEnd();
          const accesses = references.map((reference) => ({
            reference,
            access: accessKind(reference, program),
          }));
          const uses = accesses
            .filter(({ access }) => reaches(kind, access))
            .map(({ reference }) => reference);
          if (uses.some((reference) => !inside(reference))) {
            continue;
          }
          const reason = reachedThroughType(name, kind, node, checker, service, program, index);
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
            parameter: ts.isParameter(member),
            unresolved: accesses.filter(({ access }) => access === 'unresolved').length,
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
            // A compound assignment is deliberately not a read here: a field
            // that only accumulates and nothing observes is dead storage, and
            // narrowing it to `private` would only move the finding to Biome.
            reads: accesses.filter(({ access }) => access === 'read').length,
            componentOnly: (fromComponents.get(moduleKey(file.fileName)) ?? new Set()).has(name),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return { findings, cleared, unjudged };
}

export function checkUnusedClassMembers(root = process.cwd(), configName) {
  const { findings, cleared, unjudged } = unusedClassMembers(root, configName);
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
  const unowned =
    unjudged.length === 0
      ? ''
      : `${problems === '' && kept === '' ? '' : '\n'}Not judged, because the name is not an identifier (${unjudged.length})\n${unjudged
          .map(({ member, path, line }) => `${member} ${path}:${line}\n`)
          .join('')}`;
  return { status: findings.length === 0 ? 0 : 1, stdout: problems + kept + unowned };
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = checkUnusedClassMembers();
  process.stdout.write(result.stdout);
  process.exitCode = result.status;
}
