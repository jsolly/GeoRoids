import assert from 'node:assert/strict';
import { test } from 'vitest';
import { settingDetails } from './railway-setting-details.ts';

const secret = 'PRIVATE-SETTING-NEVER-PRINT';

test('eligible setting updates enforce every safe-value disclosure boundary', () => {
  const cases: Array<['build' | 'deploy', string, unknown, boolean]> = [
    ['deploy', 'drainingSeconds', 0, true],
    ['deploy', 'drainingSeconds', 3600, true],
    ['deploy', 'drainingSeconds', 3601, false],
    ['deploy', 'drainingSeconds', 0.5, false],
    ['deploy', 'healthcheckTimeout', '30', false],
    ['deploy', 'multiRegionConfig', { iad: { numReplicas: 20 } }, true],
    ['deploy', 'multiRegionConfig', { iad: { numReplicas: 21 } }, false],
    ['deploy', 'multiRegionConfig', { iad: { numReplicas: 0.5 } }, false],
    ['deploy', 'ipv6EgressEnabled', false, true],
    ['deploy', 'useLegacyStacker', true, true],
    ['deploy', 'useLegacyStacker', secret, false],
    ['deploy', 'runtime', 'V2', true],
    ['deploy', 'runtime', secret, false],
    ['build', 'buildEnvironment', 'V3', true],
    ['build', 'builder', secret, false],
    ['build', 'railpackVersion', '0.43.0', true],
    ['build', 'railpackVersion', secret, false],
  ];
  for (const [field, key, value, accepted] of cases) {
    const details = settingDetails(field, {}, { [key]: value });
    assert.equal(details.status, accepted ? 'complete' : 'incomplete');
    assert.equal(details.changes[0]?.after.state, accepted ? 'value' : 'withheld');
    assert.equal(JSON.stringify(details).includes(secret), false);
  }
});
