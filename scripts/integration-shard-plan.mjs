import { relative, resolve } from 'node:path';

export const MAX_ACTIVE_SHARDS = 3;
export function isShardCapacity(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_ACTIVE_SHARDS;
}
export function parseShardCapacity(value = String(MAX_ACTIVE_SHARDS)) {
  requireValue(
    typeof value === 'string' && /^[1-3]$/u.test(value),
    'GEOROIDS_TEST_MAX_ACTIVE_SHARDS must be 1, 2 or 3'
  );
  return Number(value);
}
const allocationWeights = [1, 1, 1, 1, 1, 1];

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
export function planShards({
  worktree,
  files,
  discovery,
  weights,
  runId,
  total = 6,
  maxActive = MAX_ACTIVE_SHARDS,
}) {
  requireValue(total === 6, 'Exactly six shards are required');
  requireValue(
    isShardCapacity(maxActive),
    'Active shard capacity must be an integer from 1 through 3'
  );
  requireValue(weights.version === 2 && Array.isArray(weights.entries), 'Invalid weight schema');
  const references = new Map();
  for (const entry of weights.entries) {
    requireValue(
      /^tests\/integration\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.path) &&
        !entry.path.split('/').includes('..'),
      'Invalid weight path'
    );
    requireValue(!references.has(entry.path), 'Duplicate weight path');
    requireValue(
      Number.isSafeInteger(entry.cases) &&
        entry.cases > 0 &&
        Number.isFinite(entry.wholeFileMs) &&
        entry.wholeFileMs > 0,
      'Whole-file weights must be positive finite times and case counts positive integers'
    );
    references.set(entry.path, entry);
  }
  requireValue(references.size > 0, 'Empty weight manifest');
  const rates = [...references.values()]
    .map((entry) => entry.wholeFileMs / entry.cases)
    .sort((a, b) => a - b);
  const fallbackFileMsPerCase = rates[Math.floor(rates.length / 2)];
  const counts = new Map();
  for (const entry of discovery) {
    const file = resolve(entry.file);
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  requireValue(
    new Set(files).size === files.length && files.length >= total,
    'Duplicate or empty inventory'
  );
  const inventory = files.map((file) => {
    const path = relative(worktree, file).replaceAll('\\', '/');
    requireValue(
      path.startsWith('tests/integration/') && !path.split('/').includes('..'),
      'Inventory escaped integration'
    );
    const cases = counts.get(resolve(file));
    requireValue(Number.isSafeInteger(cases) && cases > 0, 'Every file needs discovered cases');
    const old = references.get(path),
      measured = old && old.cases === cases;
    return {
      file: resolve(file),
      path,
      cases,
      estimatedFileMs: measured
        ? old.wholeFileMs
        : Math.ceil(fallbackFileMsPerCase * cases * 1.2 + 600),
      fallback: measured ? null : old ? 'case-count-changed' : 'new-file',
    };
  });
  requireValue(counts.size === inventory.length, 'Discovery contains extra files');
  const shards = Array.from({ length: total }, (_, offset) => ({
    index: offset + 1,
    allocationWeight: allocationWeights[offset],
    estimatedFileMs: 0,
    cases: 0,
    files: [],
  }));
  for (const entry of [...inventory].sort(
    (a, b) => b.estimatedFileMs - a.estimatedFileMs || a.path.localeCompare(b.path, 'en')
  )) {
    const shard = [...shards].sort(
      (a, b) =>
        a.estimatedFileMs / a.allocationWeight - b.estimatedFileMs / b.allocationWeight ||
        a.index - b.index
    )[0];
    shard.files.push(entry.file);
    shard.estimatedFileMs += entry.estimatedFileMs;
    shard.cases += entry.cases;
  }
  return {
    version: 2,
    runId,
    worktree,
    total,
    maxActive,
    weightStatus: weights.status,
    weightRevision: weights.revision,
    weightSourceArtifactSha256: weights.sourceArtifactSha256,
    fallbackFileMsPerCase,
    obsoleteWeights: [...references.keys()].filter(
      (path) => !inventory.some((entry) => entry.path === path)
    ),
    inventory: inventory.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    shards,
  };
}
export function selectShard(plan, files, index, count) {
  requireValue(
    plan.version === 2 &&
      isShardCapacity(plan.maxActive) &&
      count === 6 &&
      plan.total === count &&
      Number.isInteger(index) &&
      index >= 1 &&
      index <= count,
    'Invalid sequencer shard index/count'
  );
  const actual = files.map((file) => resolve(file)).sort();
  const expected = plan.inventory.map((entry) => entry.file).sort();
  requireValue(
    new Set(actual).size === actual.length && JSON.stringify(actual) === JSON.stringify(expected),
    'Vitest candidate inventory differs from discovery'
  );
  const assigned = plan.shards.flatMap((shard) => shard.files).sort();
  requireValue(
    JSON.stringify(assigned) === JSON.stringify(expected),
    'Assignment inventory differs from discovery'
  );
  requireValue(
    plan.shards.every(
      (shard, offset) =>
        shard.index === offset + 1 &&
        shard.allocationWeight === allocationWeights[offset] &&
        shard.files.length > 0
    ),
    'Invalid allocation weights or empty shards'
  );
  const selected = plan.shards.find((shard) => shard.index === index);
  requireValue(
    selected &&
      plan.shards.length === count &&
      new Set(plan.shards.map((shard) => shard.index)).size === count,
    'Invalid assignment buckets'
  );
  return selected.files;
}
