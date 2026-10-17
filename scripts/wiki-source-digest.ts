import { createHash } from 'node:crypto';

// Dependency version bumps (Dependabot, lockfile refreshes) do not change any Wiki
// rule, so the package.json digest ignores version strings inside these sections.
// Package names, nesting, field order and every other manifest field stay hashed:
// adding or removing a package, or changing scripts or engines, still needs review.
const DEPENDENCY_VERSION_FIELDS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
]);
function withoutVersionStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return '';
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, withoutVersionStrings(entry)])
    );
  }
  return value;
}
function reviewedContent(path: string, bytes: Buffer): Buffer | string {
  if (path !== 'package.json') {
    return bytes;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return bytes;
  }
  return JSON.stringify(
    Object.entries(manifest).map(([field, value]) => [
      field,
      DEPENDENCY_VERSION_FIELDS.has(field) ? withoutVersionStrings(value) : value,
    ])
  );
}
/** The accepted-review digest of one tracked Wiki source. */
export function wikiSourceDigest(path: string, bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(reviewedContent(path, bytes)).digest('hex')}`;
}
