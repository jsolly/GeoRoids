import { expect, test } from 'vitest';
import type { Roid } from '../../../src/entities/roid/Roid';
import { canDrawAsteroid, rocksForPlayfieldZoom } from '../../../src/entities/roid/roidRenderer';

test('a finite pose with offsets is drawable', () => {
  expect(
    canDrawAsteroid({
      position: { x: 10, y: -4 },
      r: 20,
      angle: 0.2,
      offsets: [1, 0.9, 1.1],
    })
  ).toBe(true);
});

test('NaN poses are skipped so one bad roid cannot crash the frame', () => {
  expect(
    canDrawAsteroid({
      position: { x: Number.NaN, y: 0 },
      r: 20,
      angle: 0,
      offsets: [1],
    })
  ).toBe(false);
});

test('empty offsets still draw — same pose the minimap already dots', () => {
  expect(
    canDrawAsteroid({
      position: { x: 0, y: 0 },
      r: 20,
      angle: 0,
      offsets: [],
    })
  ).toBe(true);
});

test('playfield zoom ignores pending rocks the canvas will skip', () => {
  const drawn = {
    position: { x: 4, y: 5 },
    r: 20,
    angle: 0,
    offsets: [1],
    vertices: 8,
    pendingDestruction: false,
    pendingUntilMs: 0,
  } as unknown as Roid;
  const pending = {
    ...drawn,
    position: { x: 0, y: 0 },
    pendingDestruction: true,
    pendingUntilMs: Date.now() + 800,
  } as unknown as Roid;
  expect(rocksForPlayfieldZoom([drawn, pending])).toEqual([
    expect.objectContaining({ position: { x: 4, y: 5 } }),
  ]);
});
