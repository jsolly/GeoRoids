import assert from 'node:assert/strict';
import { afterEach, describe, expect, test } from 'vitest';
import { ShockwaveManager } from '../../../src/fx/ShockwaveManager';
import {
  easedRingRadius,
  framesToMs,
  ringAlpha,
  SHOCKWAVE_WAVES,
  shockwaveLifetimeMs,
  waveVisualProgress,
} from '../../../src/physics/shockwave';

describe('phosphor shockwave rings', () => {
  afterEach(() => {
    const manager = ShockwaveManager.getInstance();
    manager.clear();
    manager.setWaveFireHandler(null);
  });

  test('the fast ring is visible immediately and the heavy ring waits', () => {
    const [fast, heavy] = SHOCKWAVE_WAVES;
    assert.ok(fast);
    assert.ok(heavy);
    expect(waveVisualProgress(0, fast)).toBe(0);
    expect(waveVisualProgress(0, heavy)).toBeNull();
    expect(waveVisualProgress(framesToMs(heavy.delayFrames), heavy)).toBe(0);
  });

  test('rings ease out and fade as they expand', () => {
    const mid = easedRingRadius(0.5, 400);
    expect(mid).toBeGreaterThan(200);
    expect(mid).toBeLessThan(400);
    expect(ringAlpha(0, 0.9)).toBeCloseTo(0.9);
    expect(ringAlpha(1, 0.9)).toBe(0);
  });

  test('manager fires a small fast wave then a delayed heavy wave', () => {
    const fired: string[] = [];
    const manager = ShockwaveManager.getInstance();
    manager.setWaveFireHandler((_origin, wave) => {
      fired.push(wave.id);
    });

    const t0 = 1_000;
    manager.spawn({ x: 10, y: 20 }, t0);
    expect(fired).toEqual(['fast']);
    expect(manager.getActive(t0)).toHaveLength(1);

    manager.update(t0 + framesToMs(7));
    expect(fired).toEqual(['fast', 'heavy']);
  });

  test('spent shockwaves expire after both rings finish', () => {
    const manager = ShockwaveManager.getInstance();
    const t0 = 50;
    manager.spawn({ x: 0, y: 0 }, t0);
    manager.update(t0 + shockwaveLifetimeMs() + 1);
    expect(manager.getActive(t0 + shockwaveLifetimeMs() + 1)).toHaveLength(0);
  });

  test('debug state reports the padded lifetime and fired waves', () => {
    const manager = ShockwaveManager.getInstance();
    const [fast, heavy] = SHOCKWAVE_WAVES;
    assert.ok(fast);
    assert.ok(heavy);
    const t0 = 2_000;
    manager.spawn({ x: 1, y: 2 }, t0);
    const debug = manager.getDebugState(t0);
    expect(debug.count).toBe(1);
    expect(debug.lifetimeMs).toBe(framesToMs(heavy.delayFrames + heavy.durationFrames) + 80);
    expect(debug.items[0]?.fired).toEqual([fast.id]);
  });
});
