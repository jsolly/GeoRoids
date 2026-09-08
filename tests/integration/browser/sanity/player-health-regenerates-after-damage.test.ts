import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

test(
  'player health regenerates after damage',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    type ShipHealthSnapshot = {
      exploding: boolean;
      health: number;
      lives: number;
      maxHealth: number;
    };

    const getShipHealthSnapshot = async (): Promise<ShipHealthSnapshot> =>
      page.evaluate(() => {
        const gc = (window as any).gameController;
        const player = gc?.playerManager?.getLocalPlayer?.();
        if (!player?.ship) {
          throw new Error('Local player snapshot is unavailable');
        }
        return {
          exploding: player.ship.exploding,
          health: player.ship.health,
          lives: player.lives,
          maxHealth: player.ship.maxHealth,
        };
      });

    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false });

    // Isolate the health lifecycle from the active asteroid belt and ambient
    // combatants, then acknowledge the exact pose before applying server damage.
    const fixturePosition = { x: -1700, y: 0 };
    await game.placeShipAt(fixturePosition.x, fixturePosition.y);
    const attacker = new GameInteractions(await browserManager.createAdditionalPage());
    await attacker.bootGame({ waitForCombatReady: false });
    await attacker.placeShipAt(-1800, 0);
    await Promise.all([game.waitForCombatReady(), attacker.waitForCombatReady()]);
    await attacker.waitForRemoteHumanPlayers(1);
    await game.placeShipAt(-1700, 0);

    const livesBefore = await game.getLives();
    const beforeDamage = await getShipHealthSnapshot();
    const healthBeforeDamage = beforeDamage.health;
    await attacker.fireLaserAtRemotePlayer(await game.getLocalPlayerId());
    await attacker.placeShipAt(1700, 0);
    const damagedHealth = healthBeforeDamage - 25;
    await game.waitForShipHealth(damagedHealth);

    // Require gradual recovery on the same life. Terrain can move the ship;
    // a respawn restores full health and must not satisfy this predicate.
    let previous: ShipHealthSnapshot | null = await getShipHealthSnapshot();
    const recovery: { pair?: { before: ShipHealthSnapshot; after: ShipHealthSnapshot } } = {};
    await expect
      .poll(
        async () => {
          const current = await getShipHealthSnapshot();
          if (
            current.exploding ||
            current.health <= 0 ||
            current.lives !== livesBefore ||
            current.health >= current.maxHealth
          ) {
            // Only the same live, partially damaged pilot can recover.
            previous = null;
            return false;
          }

          if (previous && previous.maxHealth === current.maxHealth) {
            const healthDelta = current.health - previous.health;
            if (healthDelta >= 2) {
              throw new Error(
                `player health jumped by ${healthDelta.toFixed(2)} in one 100 ms sample; ` +
                  'gradual regeneration cannot be distinguished from pickup healing'
              );
            }
            if (healthDelta > 0 && current.health > damagedHealth) {
              recovery.pair = { before: previous, after: current };
            }
          }

          // Growth starts a new pair; its healing jump cannot satisfy regen.
          previous = current;
          return recovery.pair !== undefined;
        },
        {
          timeout: 15000,
          interval: 100,
          message: 'health should regenerate gradually without a life loss or respawn',
        }
      )
      .toBe(true);

    const recoveryPair = recovery.pair;
    expect(recoveryPair).toBeDefined();
    if (!recoveryPair) {
      return;
    }
    expect(recoveryPair.after.health).toBeGreaterThan(recoveryPair.before.health);
    expect(recoveryPair.after.health - recoveryPair.before.health).toBeLessThan(2);
    expect(recoveryPair.after.health).toBeGreaterThan(damagedHealth);
    expect(recoveryPair.after.health).toBeLessThan(recoveryPair.after.maxHealth);
    expect(recoveryPair.before.lives).toBe(livesBefore);
    expect(recoveryPair.after.lives).toBe(livesBefore);
    expect(recoveryPair.before.maxHealth).toBe(recoveryPair.after.maxHealth);
  },
  TestConfig.DEFAULT_TIMEOUT
);
