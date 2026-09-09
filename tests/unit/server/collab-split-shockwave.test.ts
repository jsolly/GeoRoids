/* @vitest-environment node */
import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';
import { GameEngine } from '../../../server/core/GameEngine';
import { SHOCKWAVE } from '../../../src/constants';
import { framesToMs } from '../../../src/physics/shockwave';

describe('Scenario: queued collab shockwaves preserve size-scaled impulse', () => {
  test('a queued wave shoves a nearby crumb harder than a nearby giant', () => {
    const engine = new GameEngine(1);
    engine.createAsteroids(3);
    const [crumb, giant] = engine.getAllAsteroids();
    assert.ok(crumb, 'queued crumb asteroid');
    assert.ok(giant, 'queued giant asteroid');
    const requiredCrumb = crumb;
    const requiredGiant = giant;

    engine.updateAsteroid(requiredCrumb.id, {
      position: { x: 24, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 12,
    });
    engine.updateAsteroid(requiredGiant.id, {
      position: { x: 24, y: 0 },
      velocity: { x: 0, y: 0 },
      size: 50,
    });

    engine.queueCollabShockwave({ x: 0, y: 0 }, 0);

    const afterFastCrumb = engine.getAsteroid(requiredCrumb.id);
    assert.ok(afterFastCrumb, 'fast crumb asteroid');
    const afterFastGiant = engine.getAsteroid(requiredGiant.id);
    assert.ok(afterFastGiant, 'fast giant asteroid');
    const fastCrumbKick = Math.hypot(afterFastCrumb.velocity.x, afterFastCrumb.velocity.y);
    const fastGiantKick = Math.hypot(afterFastGiant.velocity.x, afterFastGiant.velocity.y);
    expect(fastCrumbKick).toBeGreaterThan(fastGiantKick);
    expect(engine.getPendingShockwaveCount()).toBe(1);

    engine.flushDueShockwaves(framesToMs(SHOCKWAVE.HEAVY.delayFrames));
    const afterHeavyCrumb = engine.getAsteroid(requiredCrumb.id);
    assert.ok(afterHeavyCrumb, 'heavy crumb asteroid');
    const afterHeavyGiant = engine.getAsteroid(requiredGiant.id);
    assert.ok(afterHeavyGiant, 'heavy giant asteroid');
    expect(Math.hypot(afterHeavyCrumb.velocity.x, afterHeavyCrumb.velocity.y)).toBeGreaterThan(
      fastCrumbKick
    );
    expect(Math.hypot(afterHeavyGiant.velocity.x, afterHeavyGiant.velocity.y)).toBeGreaterThan(
      fastGiantKick
    );
    expect(engine.getPendingShockwaveCount()).toBe(0);
  });
});
