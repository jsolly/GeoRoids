import { expect, test } from 'vitest';
import {
  formatDebugFps,
  formatDebugMotion,
  formatDebugReleases,
  formatDebugRtt,
  formatDebugSnapshot,
  formatDebugWorld,
} from '../../../src/ui/debugHud';

test('Debug HUD formatters keep the overlay compact and skip missing samples', () => {
  expect(formatDebugFps(undefined)).toBe('—');
  expect(formatDebugFps(60)).toBe('60');
  expect(formatDebugRtt(28)).toBe('28 ms');
  expect(formatDebugSnapshot(1842, 33)).toBe('1842 · 33 ms');
  expect(formatDebugMotion({ mode: 'free', epoch: 4, ack: 3 })).toBe('free · e4 · a3');
  expect(formatDebugWorld(2, 80, 3)).toBe('2p · 80a · 3l');
  expect(formatDebugReleases('a02282efc1d2e3f4a5b6c7d8e9f0aabbccddeeff', 'dev')).toBe(
    'a02282e / dev'
  );
});
