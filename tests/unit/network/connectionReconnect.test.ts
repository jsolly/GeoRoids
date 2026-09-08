import { expect, test } from 'vitest';
import {
  nextReconnectDelayMs,
  RECONNECT_DELAYS_MS,
} from '../../../src/network/services/connectionReconnect';

test('reconnect delays cover five attempts then give up', () => {
  expect(RECONNECT_DELAYS_MS).toEqual([500, 1000, 2000, 4000, 8000]);
  expect(nextReconnectDelayMs(0)).toBe(500);
  expect(nextReconnectDelayMs(4)).toBe(8000);
  expect(nextReconnectDelayMs(5)).toBeNull();
  expect(nextReconnectDelayMs(-1)).toBeNull();
});
