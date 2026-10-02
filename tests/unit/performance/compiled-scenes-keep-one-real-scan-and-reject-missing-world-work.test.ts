import { expect, test } from 'vitest';
import {
  type ClientSceneFrame,
  clientSceneSpiders,
  clientSceneTraits,
  verifyClientSceneAbility,
  verifyClientScenePresentation,
} from '../../../benchmarks/client-scenes';
import { Ship } from '../../../src/entities/ship/Ship';

test('both scan presets activate once through the ship and retain actual lifecycle expiry and cooldown', () => {
  for (const scene of ['scan-wide', 'scan-transition'] as const) {
    const traits = clientSceneTraits(scene);
    const ship = new Ship({ kitId: 'scout' });
    ship.position = { x: 0, y: 0 };
    ship.velocity = { x: 0, y: 0 };
    ship.serverOwnsMotion = true;
    if (traits.activation === 'before-warmup') {
      expect(ship.activateAbility()).toBe(true);
    }
    for (let frame = 0; frame < traits.warmupFrames; frame++) {
      ship.update();
    }
    if (traits.activation === 'after-warmup') {
      expect(ship.activateAbility()).toBe(true);
    }
    expect(ship.abilityActiveFrames).toBe(scene === 'scan-wide' ? 60 : 120);
    // A second activation must remain rejected; no fixture cooldown-reset shortcut.
    expect(ship.activateAbility()).toBe(false);
    for (let frame = 0; frame < traits.measuredFrames; frame++) {
      ship.update();
    }
    expect(() =>
      verifyClientSceneAbility(scene, ship.abilityActiveFrames, ship.abilityCooldownFrames)
    ).not.toThrow();
    expect(ship.position).toEqual({ x: 0, y: 0 });
    expect(() =>
      verifyClientSceneAbility(scene, ship.abilityActiveFrames + 1, ship.abilityCooldownFrames)
    ).toThrow('lifecycle');
  }
});

test('dynamic scene evidence rejects missing projection probes and omitted scan or spider drawing', () => {
  const viewport = { width: 390, height: 844 };
  const quiet = (length: number): ClientSceneFrame[] =>
    Array.from({ length }, (_, index) => ({
      frame: index + 1,
      zoom: 1,
      nativeScale: 1,
      virtualWidth: 390,
      virtualHeight: 844,
      activeFrames: 0,
      cooldownFrames: 0,
      worldLayerBegins: 1,
      spiderLegStrokes: 0,
      spiderBodyEllipses: 0,
      infestationStrokes: 0,
      canvasCreates: 0,
    }));
  expect(() => verifyClientScenePresentation('scan-transition', viewport, [])).toThrow(
    'Missing scene probe'
  );
  expect(() => verifyClientScenePresentation('scan-transition', viewport, quiet(240))).toThrow(
    'Scan entry'
  );
  expect(() => verifyClientScenePresentation('scan-wide', viewport, quiet(45))).toThrow(
    'Steady scan'
  );
  expect(() => verifyClientScenePresentation('spider-field', viewport, quiet(120))).toThrow(
    'omitted observed'
  );
  const brokenProjection = quiet(120);
  if (brokenProjection[0]) {
    brokenProjection[0].virtualWidth = 780;
  }
  expect(() => verifyClientScenePresentation('spider-field', viewport, brokenProjection)).toThrow(
    'inconsistent'
  );
  const missingBoundary = quiet(120);
  if (missingBoundary[0]) {
    missingBoundary[0].worldLayerBegins = 0;
  }
  expect(() => verifyClientScenePresentation('spider-field', viewport, missingBoundary)).toThrow(
    'Missing scene probe'
  );
  const wrongNativeTransform = quiet(120);
  if (wrongNativeTransform[0]) {
    wrongNativeTransform[0].nativeScale = 2;
  }
  expect(() =>
    verifyClientScenePresentation('spider-field', viewport, wrongNativeTransform)
  ).toThrow('inconsistent');
  const invalidGeometry = quiet(120);
  if (invalidGeometry[0]) {
    invalidGeometry[0].virtualWidth = Number.NaN;
  }
  expect(() => verifyClientScenePresentation('spider-field', viewport, invalidGeometry)).toThrow(
    'Missing scene probe'
  );
  const spiders = clientSceneSpiders();
  expect(spiders).toHaveLength(10);
  expect(new Set(spiders.map((spider) => spider.id)).size).toBe(10);
  expect(
    spiders.every(
      (spider) =>
        Math.abs(spider.position.x) <= 90 && Math.abs(spider.position.y) === 60 && !spider.crawler
    )
  ).toBe(true);
  const next = clientSceneSpiders();
  if (spiders[0]) {
    spiders[0].position.x = 999;
  }
  expect(next[0]?.position.x).toBe(-90);
});
