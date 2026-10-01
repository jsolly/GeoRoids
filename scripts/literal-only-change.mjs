import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pruneRequire = createRequire(require.resolve('ts-prune'));
const { ts } = pruneRequire('ts-morph');

// Only literal values in constant data initializers are eligible. Strings used
// in calls, module references, type syntax or computed/property keys stay exact.
function normalized(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) {
    return null;
  }
  const leaves = [];
  function data(node) {
    if (
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    ) {
      leaves.push([
        node.getStart(file),
        node.end,
        ts.isNumericLiteral(node) ? 'number' : 'boolean',
      ]);
      return true;
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    ) {
      return ts.isNumericLiteral(node.operand) && data(node.operand);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every(data);
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          data(property.initializer)
      );
    }
    if (
      ts.isAsExpression(node) &&
      node.type.kind === ts.SyntaxKind.TypeReference &&
      node.type.getText(file) === 'const'
    ) {
      return data(node.expression);
    }
    return false;
  }
  function visit(node) {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
      for (const declaration of node.declarations) {
        if (declaration.initializer) {
          const start = leaves.length;
          if (!data(declaration.initializer)) {
            leaves.length = start;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  let result = source;
  for (const [start, end, kind] of leaves.sort((a, b) => b[0] - a[0])) {
    result = `${result.slice(0, start)}<literal:${kind}>${result.slice(end)}`;
  }
  return result;
}
export function literalOnlyChange(before, after) {
  const names = Object.keys(before).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(after).sort())) {
    return false;
  }
  let changed = false;
  for (const name of names) {
    if (before[name] === after[name]) {
      continue;
    }
    changed = true;
    if (!/\.(?:[cm]?js|tsx?)$/u.test(name)) {
      return false;
    }
    const old = normalized(before[name], name);
    if (old === null || old !== normalized(after[name], name)) {
      return false;
    }
  }
  return changed;
}
