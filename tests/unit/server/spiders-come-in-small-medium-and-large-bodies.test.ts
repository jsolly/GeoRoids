import { expect, test } from 'vitest';
import { TerrainSpiderManager } from '../../../server/core/TerrainSpiderManager';
import { spiderHitRadius, spiderScale } from '../../../shared/terrainSpider';
import { spiderLook } from '../../../src/rendering/spiderRenderer';

test('a spider field mixes small, medium, and large bodies with varied silhouettes', () => {
  const variants = Array.from({ length: 60 }, (_, index) => spiderLook(`spider-${index + 1}`));
  expect(new Set(variants.map((variant) => variant.scale)).size).toBe(3);
  expect(new Set(variants.map((variant) => variant.marking)).size).toBeGreaterThan(2);
  expect(new Set(variants.map((variant) => variant.legSpan)).size).toBeGreaterThan(5);
  // Every client derives the same body from the ID alone.
  expect(spiderLook('spider-17')).toEqual(spiderLook('spider-17'));
});

test('a laser grazing a large spider hits it while the same miss clears a small one', () => {
  const ids = Array.from({ length: 60 }, (_, index) => `spider-${index + 1}`);
  const largeIndex = ids.findIndex((id) => spiderScale(id) > 1);
  const smallIndex = ids.findIndex((id) => spiderScale(id) < 1);
  expect(largeIndex).toBeGreaterThanOrEqual(0);
  expect(smallIndex).toBeGreaterThanOrEqual(0);

  // Halfway between the two radii: only per-spider sizing separates hit from miss.
  const graze =
    (spiderHitRadius(ids[largeIndex] ?? '') + spiderHitRadius(ids[smallIndex] ?? '')) / 2;
  for (const [index, expectHit] of [
    [largeIndex, true],
    [smallIndex, false],
  ] as const) {
    const manager = new TerrainSpiderManager(() => 0.5);
    let spider: ReturnType<typeof manager.spawnSpider> = null;
    for (let spawn = 0; spawn <= index; spawn++) {
      spider = manager.spawnSpider({ x: 2200 + spawn * 900, y: 2200 });
    }
    if (!spider) {
      throw new Error('Spider did not spawn');
    }
    expect(spider.id).toBe(ids[index]);
    expect(manager.getBody(spider.id)?.size).toBe(spiderHitRadius(spider.id));
    const { x, y } = spider.position;
    const hit = manager.findLaserHit({ x: x - 200, y: y + graze }, { x: x + 200, y: y + graze });
    expect(hit?.spiderId === spider.id).toBe(expectHit);
  }
});
