import assert from 'node:assert/strict';

interface SessionSummary {
  cohort: string;
  scenario: string;
  frameOver25Ratio: number;
  frameP99Ms: number;
  cpuP95Ms: number;
  inputP95Ms: number;
  inputCount: number;
  measuredSeconds: number;
}
function parseSession(value: unknown): SessionSummary {
  assert(
    value &&
      typeof value === 'object' &&
      'cohort' in value &&
      typeof value.cohort === 'string' &&
      value.cohort.length > 0 &&
      'scenario' in value &&
      typeof value.scenario === 'string'
  );
  function number(name: string) {
    assert(value && typeof value === 'object' && name in value);
    const result: unknown = Reflect.get(value, name);
    assert(typeof result === 'number' && Number.isFinite(result) && result >= 0, `Invalid ${name}`);
    return result;
  }
  const frameOver25Ratio = number('frameOver25Ratio');
  assert(frameOver25Ratio <= 1, 'Invalid ratio');
  return {
    cohort: value.cohort,
    scenario: value.scenario,
    frameOver25Ratio,
    frameP99Ms: number('frameP99Ms'),
    cpuP95Ms: number('cpuP95Ms'),
    inputP95Ms: number('inputP95Ms'),
    inputCount: number('inputCount'),
    measuredSeconds: number('measuredSeconds'),
  };
}
function pairs(value: unknown) {
  assert(Array.isArray(value) && value.length >= 3, 'Require at least three session pairs');
  return value.map((pair: unknown) => {
    assert(Array.isArray(pair) && pair.length === 2);
    return { a: parseSession(pair[0]), b: parseSession(pair[1]) };
  });
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) / 2)];
  const high = sorted[Math.floor(sorted.length / 2)];
  assert(low !== undefined && high !== undefined);
  return (low + high) / 2;
}
/** Compare whole sessions from one fixed device/browser/workload; never pool device frames. */
export function compareMobileSessions(value: unknown) {
  assert(value && typeof value === 'object' && 'aa' in value && 'ab' in value);
  const aa = pairs(value.aa);
  const ab = pairs(value.ab);
  const sessions = [...aa, ...ab].flatMap(({ a, b }) => [a, b]);
  assert(
    new Set(sessions.map((session) => session.cohort)).size === 1,
    'Cannot pool device cohorts'
  );
  assert(new Set(sessions.map((session) => session.scenario)).size === 1, 'Cannot pool workloads');
  assert(
    sessions.every((session) => session.measuredSeconds >= 300 && session.inputCount >= 300),
    'Incomplete five-minute/input evidence'
  );
  const noise = {
    frameOver25Ratio: Math.max(
      ...aa.map(({ a, b }) => Math.abs(a.frameOver25Ratio - b.frameOver25Ratio))
    ),
    frameP99Ms: Math.max(...aa.map(({ a, b }) => Math.abs(a.frameP99Ms - b.frameP99Ms))),
    cpuP95Ms: Math.max(...aa.map(({ a, b }) => Math.abs(a.cpuP95Ms - b.cpuP95Ms))),
    inputP95Ms: Math.max(...aa.map(({ a, b }) => Math.abs(a.inputP95Ms - b.inputP95Ms))),
  };
  const improvement = median(ab.map(({ a, b }) => a.frameOver25Ratio - b.frameOver25Ratio));
  const withinBudget = ab.every(
    ({ b }) =>
      b.frameOver25Ratio < 0.01 && b.frameP99Ms <= 33.3 && b.cpuP95Ms < 10 && b.inputP95Ms < 33.3
  );
  const noRegression = ab.every(
    ({ a, b }) =>
      b.frameP99Ms - a.frameP99Ms <= noise.frameP99Ms &&
      b.cpuP95Ms - a.cpuP95Ms <= noise.cpuP95Ms &&
      b.inputP95Ms - a.inputP95Ms <= noise.inputP95Ms
  );
  return {
    relativeResult:
      noRegression && improvement > noise.frameOver25Ratio ? 'improved' : 'inconclusive',
    absoluteTargetsMet: withinBudget,
    physicalAcceptance: false,
    cohort: sessions[0]?.cohort,
    scenario: sessions[0]?.scenario,
    noise,
    improvement,
    noRegression,
    acceptance:
      'Relative timing evidence only; absolute targets, workload review, physical devices and sustained acceptance are separate.',
  };
}
