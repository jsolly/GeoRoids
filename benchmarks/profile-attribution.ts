import assert from 'node:assert/strict';

function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function numbers(value: unknown): number[] {
  assert(Array.isArray(value));
  return value.map((entry: unknown) => {
    assert(typeof entry === 'number' && Number.isFinite(entry) && entry >= 0);
    return entry;
  });
}
function frame(value: unknown): string {
  object(value);
  assert(typeof value['functionName'] === 'string');
  assert(typeof value['url'] === 'string');
  assert(typeof value['lineNumber'] === 'number');
  return `${value['functionName'] || '(anonymous)'} @ ${value['url']}:${value['lineNumber'] + 1}`;
}
function sorted(rows: Map<string, number>, total: number) {
  return [...rows.entries()]
    .map(([location, weight]) => ({
      location,
      weight,
      percent: total ? (weight * 100) / total : 0,
    }))
    .sort(
      (left, right) => right.weight - left.weight || left.location.localeCompare(right.location)
    );
}

/** Inclusive rows count each function location once per stack, including recursive stacks. */
export function cpuAttribution(value: unknown) {
  object(value);
  assert(Array.isArray(value['nodes']));
  const nodes = new Map<number, { location: string; children: number[] }>();
  const parents = new Map<number, number>();
  for (const row of value['nodes']) {
    object(row);
    assert(typeof row['id'] === 'number' && Number.isSafeInteger(row['id']));
    assert(!nodes.has(row['id']), 'Duplicate CPU node');
    const children = numbers(row['children'] ?? []);
    nodes.set(row['id'], { location: frame(row['callFrame']), children });
    for (const child of children) {
      assert(!parents.has(child), 'CPU node has multiple parents');
      parents.set(child, row['id']);
    }
  }
  const samples = numbers(value['samples']);
  const deltas = numbers(value['timeDeltas']);
  assert(samples.length > 0 && samples.length === deltas.length, 'Missing CPU sample weights');
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let totalMicroseconds = 0;
  for (const [index, id] of samples.entries()) {
    const weight = deltas[index];
    assert(weight !== undefined);
    const node = nodes.get(id);
    assert(node, `CPU sample references missing node ${id}`);
    totalMicroseconds += weight;
    self.set(node.location, (self.get(node.location) ?? 0) + weight);
    let cursor: number | undefined = id;
    const visited = new Set<number>();
    const locations = new Set<string>();
    while (cursor !== undefined) {
      assert(!visited.has(cursor), 'CPU call tree contains a cycle');
      visited.add(cursor);
      const ancestor = nodes.get(cursor);
      assert(ancestor, 'CPU stack references missing parent');
      locations.add(ancestor.location);
      cursor = parents.get(cursor);
    }
    for (const location of locations) {
      inclusive.set(location, (inclusive.get(location) ?? 0) + weight);
    }
  }
  assert(totalMicroseconds > 0);
  return {
    unit: 'sampled microseconds',
    totalMicroseconds,
    samples: samples.length,
    self: sorted(self, totalMicroseconds),
    inclusive: sorted(inclusive, totalMicroseconds),
  };
}

/** V8's sampling estimates include collected objects only when the capture requested both GC flags. */
export function allocationAttribution(value: unknown) {
  object(value);
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  function visit(row: unknown, ancestors: readonly string[]): number {
    object(row);
    const location = frame(row['callFrame']);
    const size = row['selfSize'];
    assert(typeof size === 'number' && Number.isFinite(size) && size >= 0);
    assert(Array.isArray(row['children']));
    self.set(location, (self.get(location) ?? 0) + size);
    for (const ancestor of new Set([...ancestors, location])) {
      inclusive.set(ancestor, (inclusive.get(ancestor) ?? 0) + size);
    }
    return (
      size +
      row['children'].reduce<number>(
        (sum, child: unknown) => sum + visit(child, [...ancestors, location]),
        0
      )
    );
  }
  const estimatedBytes = visit(value['head'], []);
  assert(estimatedBytes > 0, 'Allocation profile contains no sampled bytes');
  return {
    unit: 'V8 estimated allocated bytes',
    estimatedBytes,
    self: sorted(self, estimatedBytes),
    inclusive: sorted(inclusive, estimatedBytes),
  };
}
