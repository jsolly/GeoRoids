import { expect, test } from 'vitest';

import { shouldApplyRemoteShoot } from '../../../src/entities/player/remoteLasers';

test('local shoot echoes and full magazines are dropped', () => {
  expect(shouldApplyRemoteShoot({ id: 'me', type: 'local', ship: { lasers: [] } }, 'me', 5)).toBe(
    false
  );
  expect(shouldApplyRemoteShoot({ id: 'me', type: 'remote', ship: { lasers: [] } }, 'me', 5)).toBe(
    false
  );
  expect(
    shouldApplyRemoteShoot(
      { id: 'other', type: 'remote', ship: { lasers: [1, 2, 3, 4, 5] } },
      'me',
      5
    )
  ).toBe(false);
  expect(
    shouldApplyRemoteShoot({ id: 'other', type: 'remote', ship: { lasers: [1] } }, 'me', 5)
  ).toBe(true);
});
