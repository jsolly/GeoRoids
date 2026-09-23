import { expect, test } from 'vitest';
import { shouldForwardClientLog } from '../../../src/utils/logForwardPolicy';

test('production clients forward warnings and errors without reconnect chatter', () => {
  expect(shouldForwardClientLog('error', 'STATE', true, 'game_loop_failed')).toBe(true);
  expect(shouldForwardClientLog('warn', 'NETWORK', true, 'WebSocket connection closed')).toBe(true);
  expect(shouldForwardClientLog('info', 'STATE', true, 'player_died')).toBe(true);
  expect(shouldForwardClientLog('info', 'STATE', true, 'player_respawned')).toBe(true);
  expect(shouldForwardClientLog('info', 'STATE', true, 'reconnect_scheduled')).toBe(false);
  expect(shouldForwardClientLog('info', 'STATE', true, 'transport_closed')).toBe(false);
  expect(shouldForwardClientLog('info', 'STATE', true, 'snapshot_applied')).toBe(false);
  expect(shouldForwardClientLog('info', 'NETWORK', true, 'Connected to server')).toBe(false);
  expect(shouldForwardClientLog('debug', 'STATE', true, 'pose')).toBe(false);
  expect(shouldForwardClientLog('warn', 'LOG_FORWARD', true, 'retry')).toBe(false);
  expect(shouldForwardClientLog('error', 'LOG_FORWARD', true, 'retry')).toBe(false);
});

test('development clients still forward selected state info', () => {
  expect(shouldForwardClientLog('info', 'STATE', false)).toBe(true);
  expect(shouldForwardClientLog('info', 'NETWORK', false)).toBe(false);
  expect(shouldForwardClientLog('debug', 'MOUSE', false)).toBe(false);
  expect(shouldForwardClientLog('warn', 'SOUND', false)).toBe(true);
});
