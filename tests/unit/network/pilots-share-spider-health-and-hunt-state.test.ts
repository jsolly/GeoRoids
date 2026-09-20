import { afterEach, expect, test } from 'vitest';
import { SnapshotDecoder, SnapshotEncoder } from '../../../shared/snapshotProtocol';
import type { SpiderFieldState } from '../../../shared-types';
import {
  getSpiderField,
  setSpiderField,
  spiderDanger,
} from '../../../src/physics/terrain/spiderSession';
import { decodeSnapshotMessage, snapshotMessage } from '../../support/decodeSnapshotMessage';
import { snapshotFixture } from './snapshotFixture';

const field: SpiderFieldState = {
  spiders: [
    {
      id: 'spider-1',
      position: { x: 2000, y: 0 },
      angle: 0,
      health: 75,
      maxHealth: 75,
      phase: 'hunting',
      targetId: 'pilot-1',
    },
  ],
};
afterEach(() => setSpiderField(undefined));

test('both pilots receive spider damage and removal through snapshots', () => {
  const world = snapshotFixture();
  world.spiderField = structuredClone(field);
  const encoder = new SnapshotEncoder(world);
  const decoders = [new SnapshotDecoder(), new SnapshotDecoder()];
  for (const decoder of decoders) {
    expect(decodeSnapshotMessage(decoder, snapshotMessage(encoder.encode(1))).spiderField).toEqual(
      field
    );
  }
  const injured = world.spiderField.spiders[0];
  if (!injured) {
    throw new Error('Missing fixture spider');
  }
  injured.health = 25;
  const wounded = new SnapshotEncoder(world);
  for (const decoder of decoders) {
    const state = decodeSnapshotMessage(
      decoder,
      snapshotMessage(wounded.encode(2, { sequence: 1, state: encoder.state }))
    );
    expect(state.spiderField?.spiders[0]?.health).toBe(25);
  }
  world.spiderField = { spiders: [] };
  const dead = new SnapshotEncoder(world);
  for (const decoder of decoders) {
    const state = decodeSnapshotMessage(
      decoder,
      snapshotMessage(dead.encode(3, { sequence: 2, state: wounded.state }))
    );
    setSpiderField(state.spiderField);
    expect(getSpiderField().spiders).toEqual([]);
  }
});

test('warnings identify the hunted pilot and reset with the session', () => {
  setSpiderField(field);
  expect(spiderDanger({ x: 2800, y: 0 }, field, 'pilot-1')).toBe('hunted');
  expect(spiderDanger({ x: 2800, y: 0 }, field, 'pilot-2')).toBe('quiet');
  expect(spiderDanger({ x: 2250, y: 0 }, field, 'pilot-2')).toBe('nearby');
  setSpiderField(undefined);
  expect(spiderDanger({ x: 2000, y: 0 }, getSpiderField(), 'pilot-1')).toBe('quiet');
});

test('malformed health and duplicate spider IDs cannot enter the snapshot', () => {
  for (const health of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const world = snapshotFixture();
    world.spiderField = structuredClone(field);
    const spider = world.spiderField.spiders[0];
    if (!spider) {
      throw new Error('Missing fixture spider');
    }
    spider.health = health;
    expect(() => new SnapshotEncoder(world)).toThrow();
  }
  const world = snapshotFixture();
  world.spiderField = { spiders: [...field.spiders, ...field.spiders] };
  expect(() => new SnapshotEncoder(world)).toThrow();
});
