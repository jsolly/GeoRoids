import { expect, test } from 'vitest';
import { PLAYER_NAME_MAX_LENGTH, sanitizePlayerName } from '../../../src/utils/playerName';

test('title-screen nicknames keep letters, numbers, and spaces', () => {
  expect(sanitizePlayerName('  Bob  ')).toBe('Bob');
  expect(sanitizePlayerName('Quantum Night')).toBe('Quantum Night');
  expect(sanitizePlayerName('Neo-Star_99!')).toBe('NeoStar99');
  expect(sanitizePlayerName('A'.repeat(PLAYER_NAME_MAX_LENGTH + 5))).toHaveLength(
    PLAYER_NAME_MAX_LENGTH
  );
  expect(sanitizePlayerName('@@@')).toBe('');
});
