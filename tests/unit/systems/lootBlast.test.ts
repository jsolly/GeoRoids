import { describe, expect, test } from 'vitest';

import {
  LOOT_BLAST,
  blastPush,
  inBlastRadius,
  inLootArmRange,
  isSmallRoid,
} from '../../../shared/lootBlast';
import { PALETTE } from '../../../src/constants';
import { lootStrokeColor } from '../../../src/entities/loot/lootRenderer';

describe('loot blast math', () => {
  test('blast radius includes nearby hulls and excludes far ones', () => {
    expect(inBlastRadius({ x: 0, y: 0 }, { x: LOOT_BLAST.RADIUS - 1, y: 0 })).toBe(true);
    expect(inBlastRadius({ x: 0, y: 0 }, { x: LOOT_BLAST.RADIUS + 8, y: 0 })).toBe(false);
    expect(inBlastRadius({ x: 0, y: 0 }, { x: LOOT_BLAST.RADIUS + 4, y: 0 }, 10)).toBe(true);
  });

  test('arm range is generous but not map-wide', () => {
    expect(inLootArmRange({ x: 0, y: 0 }, { x: 400, y: 0 })).toBe(true);
    expect(inLootArmRange({ x: 0, y: 0 }, { x: LOOT_BLAST.ARM_RANGE + 20, y: 0 })).toBe(false);
  });

  test('push is radial away from the origin', () => {
    const push = blastPush({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(push.x).toBeCloseTo(LOOT_BLAST.PUSH);
    expect(push.y).toBeCloseTo(0);
    expect(isSmallRoid(12)).toBe(true);
    expect(isSmallRoid(40)).toBe(false);
  });

  test('kind colors stay on the locked palette', () => {
    expect(lootStrokeColor('shard')).toBe(PALETTE.LOOT);
    expect(lootStrokeColor('wreckage')).toBe(PALETTE.LOOT);
    expect(lootStrokeColor('fuel')).toBe(PALETTE.HEALTH);
    expect(PALETTE.LOOT).toBe('#E8D5A3');
  });
});
