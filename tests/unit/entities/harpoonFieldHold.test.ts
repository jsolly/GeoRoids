import { afterEach, expect, test } from 'vitest';
import {
  findHarpoonFieldBody,
  getHarpoonField,
  publishHarpoonField,
  setHoldEmptyHarpoonField,
} from '../../../src/entities/ship/harpoonField';

afterEach(() => {
  setHoldEmptyHarpoonField(false);
  // A non-empty reset also clears the module's reconnect fallback cache.
  publishHarpoonField([{ id: 'test-reset', position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } }]);
  publishHarpoonField([]);
});

test('empty publish during a WS flap keeps the last latch field', () => {
  publishHarpoonField([
    { id: 'rock-1', position: { x: 80, y: 0 }, velocity: { x: 0, y: 0 }, kind: 'asteroid' },
  ]);
  setHoldEmptyHarpoonField(true);
  publishHarpoonField([]);
  expect(getHarpoonField()).toHaveLength(1);
  expect(getHarpoonField()[0]?.id).toBe('rock-1');
});

test('a live non-empty publish releases the reconnect hold', () => {
  publishHarpoonField([{ id: 'old', position: { x: 10, y: 0 }, velocity: { x: 0, y: 0 } }]);
  setHoldEmptyHarpoonField(true);
  publishHarpoonField([{ id: 'new', position: { x: 20, y: 0 }, velocity: { x: 0, y: 0 } }]);
  expect(getHarpoonField()[0]?.id).toBe('new');
  publishHarpoonField([]);
  expect(getHarpoonField()).toHaveLength(0);
});

test('a live field snapshot retires stale reconnect latch bodies', () => {
  publishHarpoonField([
    { id: 'old-generation', position: { x: 10, y: 0 }, velocity: { x: 0, y: 0 } },
  ]);
  setHoldEmptyHarpoonField(true);
  publishHarpoonField([]);
  expect(findHarpoonFieldBody('old-generation')).toBeDefined();

  publishHarpoonField([
    { id: 'new-generation', position: { x: 20, y: 0 }, velocity: { x: 0, y: 0 } },
  ]);
  expect(findHarpoonFieldBody('old-generation')).toBeUndefined();
  expect(findHarpoonFieldBody('new-generation')?.position.x).toBe(20);
});

test('remote ships do not release the warm rock field during a socket flap', () => {
  publishHarpoonField([{ id: 'old-rock', position: { x: 10, y: 0 }, velocity: { x: 0, y: 0 } }]);
  setHoldEmptyHarpoonField(true);
  publishHarpoonField([
    {
      id: 'remote-ship',
      position: { x: 20, y: 0 },
      velocity: { x: 0, y: 0 },
      kind: 'ship',
    },
  ]);

  expect(getHarpoonField().map((body) => body.id)).toEqual(['old-rock', 'remote-ship']);
  expect(findHarpoonFieldBody('old-rock')).toBeDefined();
});
