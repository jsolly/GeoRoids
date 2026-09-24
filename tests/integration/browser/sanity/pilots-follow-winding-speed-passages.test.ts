import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { centerOf, dispatchTouch } from '../../utils/touch-input';

const { browserManager } = createBrowserScenarioHooks(__dirname);

const findPassage = `(async () => {
  const { samplePassages } = await import('/src/physics/terrain/passages.ts');
  const { getTerrainField } = await import('/src/physics/terrain/terrainSession.ts');
  const field = getTerrainField();
  return [3000, 3400].map(base => {
   for(let x = base; x < base + 300; x += 13) {
    for(let y = 0; y < 1100; y++) {
      const [route, crossing] = samplePassages(field, x, y);
      if(route.strength > 0.999 && crossing.strength === 0) {
        return {x, y, angle: Math.atan2(-route.tangentY, route.tangentX)};
      }
    }
    }
    throw new Error('Missing passage');
  });
})()`;

const speedRatio = `(async () => {
  const { cruiseSpeed } = await import('/shared/shipFlight.ts');
  const { getShipKit } = await import('/src/entities/ship/shipKits.ts');
  const ship = window.gameController.getCurrPlayer().ship;
  return Math.hypot(ship.velocity.x, ship.velocity.y) / cruiseSpeed(ship.mass, getShipKit(ship.kitId).maxVelocity);
})()`;

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900, hasTouch: false },
  { name: 'mobile', width: 390, height: 844, hasTouch: true },
]) {
  test(`two ${viewport.name} pilots ride a passage in opposite directions and can steer out`, async () => {
    const pages = [
      await browserManager.recreatePage({ hasTouch: viewport.hasTouch }),
      await browserManager.createPage({ hasTouch: viewport.hasTouch }),
    ];
    const problems: string[] = [];
    const games = pages.map((page) => new GameInteractions(page));
    for (const [index, page] of pages.entries()) {
      await page.setViewportSize(viewport);
      page.on('console', (m) => {
        if (m.type() === 'warning' || m.type() === 'error') {
          problems.push(m.text());
        }
      });
      page.on('pageerror', (e) => problems.push(e.message));
      const game = games[index];
      if (!game) {
        throw new Error('Missing pilot');
      }
      await game.bootGame({ waitForCombatReady: false });
    }
    const first = pages[0];
    const second = pages[1];
    if (!first || !second) {
      throw new Error('Missing pages');
    }
    const starts = await first.evaluate<{ x: number; y: number; angle: number }[]>(findPassage);
    const ids: string[] = [];
    for (const [index, page] of pages.entries()) {
      const game = games[index];
      const start = starts[index];
      if (!game || !start) {
        throw new Error('Missing passage start');
      }
      await game.placeShipAt(start.x, start.y);
      await game.armSpawnProtection();
      ids.push(await game.getLocalPlayerId());
      await page.evaluate(
        (angle) => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          if (!ship) {
            throw new Error('Missing ship');
          }
          ship.angle = angle;
        },
        start.angle + index * Math.PI
      );
    }
    for (const page of pages) {
      await expect
        .poll(() => page.evaluate<number>(speedRatio), { timeout: 5000, interval: 25 })
        .toBeGreaterThan(1.35);
    }
    for (const [index, page] of pages.entries()) {
      const otherId = ids[1 - index];
      if (!otherId) {
        throw new Error('Missing peer id');
      }
      // Remote ships come from authoritative snapshots, not this page's prediction.
      const peerSpeed = speedRatio.replace(
        'window.gameController.getCurrPlayer().ship',
        `window.gameController.getNetworkManager().getPlayer(${JSON.stringify(otherId)}).ship`
      );
      await expect
        .poll(() => page.evaluate<number>(peerSpeed), { timeout: 5000, interval: 25 })
        .toBeGreaterThan(1.35);
    }
    await first.screenshot({ path: `/tmp/georoids-passages-${viewport.name}.png` });
    const start = starts[0];
    if (!start) {
      throw new Error('Missing start');
    }
    const game = games[0];
    if (!game) {
      throw new Error('Missing game');
    }
    await game.placeShipAt(start.x, start.y);
    await game.armSpawnProtection();
    // Placement is setup; the actual turn goes through keyboard or touch input.
    await first.evaluate((angle) => {
      const ship = window.gameController?.getCurrPlayer()?.ship;
      if (!ship) {
        throw new Error('Missing ship');
      }
      ship.angle = angle;
    }, start.angle);
    const target = start.angle + Math.PI / 2;
    const touch = viewport.hasTouch ? await first.context().newCDPSession(first) : undefined;
    try {
      if (touch) {
        const center = await centerOf(first, '#gameCanvas');
        await dispatchTouch(touch, 'touchStart', [
          { x: center.x + 110 * Math.cos(target), y: center.y - 110 * Math.sin(target), id: 1 },
        ]);
      } else {
        await first.keyboard.down('ArrowLeft');
      }
      await first.waitForFunction((targetAngle) => {
        const angle = window.gameController?.getCurrPlayer()?.ship.angle;
        return (
          angle !== undefined &&
          Math.abs(Math.atan2(Math.sin(angle - targetAngle), Math.cos(angle - targetAngle))) < 0.12
        );
      }, target);
    } finally {
      if (touch) {
        await dispatchTouch(touch, 'touchEnd', []);
        await touch.detach();
      } else {
        await first.keyboard.up('ArrowLeft');
      }
    }
    await expect
      .poll(() => first.evaluate<number>(speedRatio), { timeout: 3000, interval: 25 })
      .toBeGreaterThan(0.9);
    expect(await first.evaluate<number>(speedRatio)).toBeLessThan(1.1);
    expect(problems).toEqual([]);
  });
}
