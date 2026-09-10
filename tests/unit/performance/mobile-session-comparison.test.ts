import { describe, expect, it } from 'vitest';
import { compareMobileSessions } from '../../../benchmarks/mobile-comparison';

const session = {
  cohort: 'iPhone16e/Safari/exact-version',
  scenario: 'combat',
  frameOver25Ratio: 0.02,
  frameP99Ms: 30,
  cpuP95Ms: 8,
  inputP95Ms: 20,
  inputCount: 500,
  measuredSeconds: 300,
};
const control = () => [
  [session, session],
  [session, session],
  [session, session],
];
const improved = () => control().map(([a]) => [a, { ...session, frameOver25Ratio: 0.005 }]);
describe('paired mobile performance evidence', () => {
  it('accepts a repeatable improvement beyond baseline noise', () => {
    expect(compareMobileSessions({ aa: control(), ab: improved() }).relativeResult).toBe(
      'improved'
    );
  });
  it('keeps overlapping baseline variation inconclusive', () => {
    expect(compareMobileSessions({ aa: improved(), ab: improved() }).relativeResult).toBe(
      'inconclusive'
    );
  });
  it('separates relative improvement from unmet absolute targets', () => {
    const ab = improved();
    ab[1] = [session, { ...session, frameOver25Ratio: 0.011 }];
    expect(compareMobileSessions({ aa: control(), ab })).toMatchObject({
      relativeResult: 'improved',
      absoluteTargetsMet: false,
      physicalAcceptance: false,
    });
  });
  it('refuses to pool a different phone or incomplete input collection', () => {
    const ab = improved();
    ab[1] = [session, { ...session, cohort: 'Android' }];
    expect(() => compareMobileSessions({ aa: control(), ab })).toThrow('cohorts');
    ab[1] = [session, { ...session, inputCount: 1 }];
    expect(() => compareMobileSessions({ aa: control(), ab })).toThrow('Incomplete');
  });
});
