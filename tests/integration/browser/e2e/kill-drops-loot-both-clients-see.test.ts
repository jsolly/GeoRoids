import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import { GROWTH } from '../../../../shared/shipGrowth';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

test(
  'two clients see the same kill-loot drops',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }
    const page2 = await browserManager.createAdditionalPage();
    const game1 = new GameInteractions(page1);
    const game2 = new GameInteractions(page2);
    const decoder = new SnapshotDecoder();
    let victimId = '';
    let livesBefore = 0;
    let deathPosition: { x: number; y: number } | undefined;
    page2.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === 'joined') {
          decoder.reset();
        } else if (message.type === 'snapshot') {
          const victim = decoder
            .decode(message.data)
            .entities.find((actor) => actor.id === victimId);
          if (victim && victim.lives < livesBefore && victim.exploding && !deathPosition) {
            deathPosition = { ...victim.position };
          }
        }
      });
    });

    // Park the collector as soon as it joins. Waiting for combat readiness on
    // both clients first leaves client 1 at the default spawn long enough for
    // ambient combat to kill it before this fixture starts.
    await game1.bootGame({ waitForCombatReady: false });
    await game1.placeShipAt(-1800, -1800);
    await game2.bootGame({ waitForCombatReady: false });

    // Keep the collector outside the active asteroid belt and away from the
    // ambient combatants while the other client is being destroyed. The victim
    // is also placed outside the belt so the only death in this fixture is the
    // hostile server-authoritative peer attack.
    await game2.placeShipAt(1800, 1800);
    await game1.waitForRemoteHumanPlayers(1);
    await game2.waitForRemoteHumanPlayers(1);
    await game1.waitForCombatReady();
    await game2.waitForCombatReady();
    victimId = await game2.getLocalPlayerId();
    livesBefore = await game2.getLives();
    const previousLoot = new Set((await game1.getLoot()).map((drop) => drop.id));
    const scoreBefore = await game1.getScore();
    for (let shot = 0; shot < 8 && (await game2.getLives()) === livesBefore; shot++) {
      await game2.placeShipAt(1800, 1800);
      const target = await game2.getShipPosition();
      await game1.placeShipAt(target.x - 120, target.y);
      await game1.fireLaserToward(target.x, target.y);
      // The shot continues on the server while the collector retreats before
      // it can overlap the victim's 16–40px wreckage scatter.
      await game1.placeShipAt(-1800, -1800);
      await page2.waitForTimeout(350);
    }
    await expect.poll(() => game2.getLives(), { timeout: 5000 }).toBeLessThan(livesBefore);
    await expect
      .poll(() => game1.getScore(), { timeout: 5000 })
      .toBeGreaterThanOrEqual(scoreBefore + 200);
    await game1.placeShipAt(-1800, -1800);
    await expect.poll(() => deathPosition, { timeout: 5000 }).toBeDefined();
    if (!deathPosition) {
      throw new Error('The victim death position was not broadcast');
    }
    const impact = deathPosition;
    const isVictimLoot = (drop: Awaited<ReturnType<GameInteractions['getLoot']>>[number]) => {
      const scatter = Math.hypot(drop.x - impact.x, drop.y - impact.y);
      return (
        drop.kind === 'wreckage' &&
        drop.id.startsWith('loot-') &&
        !previousLoot.has(drop.id) &&
        scatter >= GROWTH.SCATTER_MIN - 0.001 &&
        scatter <= GROWTH.SCATTER_MAX + 0.001
      );
    };

    await expect
      .poll(
        async () => {
          const loot1 = (await game1.getLoot()).filter(isVictimLoot);
          const loot2 = (await game2.getLoot()).filter(isVictimLoot);
          if (loot1.length === 0 || loot2.length === 0) {
            return false;
          }
          const ids1 = [...loot1.map((drop) => drop.id)].sort();
          const ids2 = [...loot2.map((drop) => drop.id)].sort();
          return ids1.join(',') === ids2.join(',');
        },
        { timeout: 12000, message: 'both clients should share new wreckage from this victim death' }
      )
      .toBe(true);

    const loot1 = (await game1.getLoot()).filter(isVictimLoot);
    const loot2 = (await game2.getLoot()).filter(isVictimLoot);
    for (const drop of loot1) {
      const peer = loot2.find((other) => other.id === drop.id);
      expect(peer).toBeDefined();
      assert.ok(peer, 'Peer did not observe the identified drop');
      expect(Math.abs(peer.x - drop.x)).toBeLessThan(8);
      expect(Math.abs(peer.y - drop.y)).toBeLessThan(8);
    }

    await page1.screenshot({
      path: screenshotManager.getScreenshotPath('kill-loot-client1-shared-drops.png'),
    });
    await page2.screenshot({
      path: screenshotManager.getScreenshotPath('kill-loot-client2-shared-drops.png'),
    });

    const pellet = loot1[0];
    expect(pellet).toBeDefined();
    assert.ok(pellet, 'Fuel pellet missing from this kill');
    const startMass = await game1.getShipMass();
    const startRadius = await game1.getShipRadius();
    const startMaxHealth = await game1.getShipMaxHealth();
    await game1.placeShipAt(pellet.x, pellet.y);
    await expect
      .poll(async () => (await game1.getLoot()).some((drop) => drop.id === pellet.id))
      .toBe(false);

    await expect
      .poll(async () => game1.getShipMass(), {
        timeout: 8000,
        message: 'collector should grow after picking up kill loot',
      })
      .toBeGreaterThan(startMass);

    expect(await game1.getShipRadius()).toBeGreaterThan(startRadius);
    expect(await game1.getShipMaxHealth()).toBeGreaterThan(startMaxHealth);

    await page1.screenshot({
      path: screenshotManager.getScreenshotPath('kill-loot-client1-after-collect.png'),
    });
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
