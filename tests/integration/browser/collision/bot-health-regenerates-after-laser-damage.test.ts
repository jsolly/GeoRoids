import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

test(
  'a hostile bot regenerates health after laser damage while alive',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    type BotHealthSnapshot = {
      exploding: boolean;
      health: number;
      lives: number;
      maxHealth: number;
    };

    const getBotHealthSnapshot = async (botId: string): Promise<BotHealthSnapshot | null> =>
      page.evaluate((id) => {
        const gc = window.gameController;
        const bot = (gc?.getNetworkManager?.().getAllPlayers?.() ?? []).find(
          (player) => player.id === id && player.type === 'bot'
        );
        if (!bot?.ship) {
          return null;
        }
        return {
          exploding: bot.ship.exploding,
          health: bot.ship.health,
          lives: bot.lives,
          maxHealth: bot.ship.maxHealth,
        };
      }, botId);

    const game = new GameInteractions(page);
    await game.bootGame();
    await game.waitForBots(1);

    const hostileBotId = await game.getHostileBotId();
    const bot = (await game.getBots()).find((candidate) => candidate.id === hostileBotId);
    expect(bot, 'an alive hostile bot should be available for laser damage').toBeDefined();
    if (!bot) {
      return;
    }

    const initialSnapshot = await getBotHealthSnapshot(bot.id);
    expect(initialSnapshot, 'the hostile bot should have an authoritative snapshot').toBeDefined();
    if (!initialSnapshot) {
      return;
    }
    expect(Number.isFinite(initialSnapshot.lives), 'the bot snapshot should include lives').toBe(
      true
    );

    const initialHealth = initialSnapshot.health;
    const initialLives = initialSnapshot.lives;
    const result = await game.attackBotWithLasers(bot.id, 1);
    const damageEvidence: { snapshot?: BotHealthSnapshot } = {};
    const damageSamples: Array<BotHealthSnapshot | null> = [];
    try {
      await expect
        .poll(
          async () => {
            const current = await getBotHealthSnapshot(bot.id);
            damageSamples.push(current);
            if (
              current &&
              !current.exploding &&
              current.health > 0 &&
              current.lives === initialLives &&
              current.maxHealth === initialSnapshot.maxHealth &&
              initialHealth - current.health > 10
            ) {
              damageEvidence.snapshot = current;
            }
            return damageEvidence.snapshot !== undefined;
          },
          {
            timeout: 5000,
            interval: 50,
            message: 'the same live bot should show the material laser hit',
          }
        )
        .toBe(true);
    } catch (error) {
      console.error(
        'Bot laser damage evidence',
        JSON.stringify({ initialSnapshot, result, damageSamples })
      );
      throw error;
    }

    const damagedSnapshot = damageEvidence.snapshot;
    expect(damagedSnapshot, 'bot should take material laser damage while alive').toBeDefined();
    if (!damagedSnapshot) {
      return;
    }

    // Park away from the fight before waiting. The assertion requires a live,
    // partially damaged bot, so a full-health respawn can never satisfy it.
    await game.placeShipAt(-1700, 0);

    let previous: BotHealthSnapshot | null = damagedSnapshot;
    const recovery: { pair?: { before: BotHealthSnapshot; after: BotHealthSnapshot } } = {};
    const samples: Array<BotHealthSnapshot | null> = [];
    try {
      await expect
        .poll(
          async () => {
            const current = await getBotHealthSnapshot(bot.id);
            samples.push(current);
            if (
              !current ||
              current.exploding ||
              current.health <= 0 ||
              current.lives !== initialLives ||
              current.health >= current.maxHealth
            ) {
              // Only a live, partially damaged bot can begin a recovery pair.
              previous = null;
              return false;
            }

            if (previous && previous.maxHealth === current.maxHealth) {
              const healthDelta = current.health - previous.health;
              if (healthDelta >= 2) {
                throw new Error(
                  `bot health jumped by ${healthDelta.toFixed(2)} in one 100 ms sample; ` +
                    'gradual regeneration cannot be distinguished from pickup healing'
                );
              }
              if (healthDelta > 0) {
                recovery.pair = { before: previous, after: current };
              }
            }

            // Growth starts a new pair; its healing jump cannot satisfy regen.
            previous = current;
            return recovery.pair !== undefined;
          },
          {
            timeout: 20000,
            interval: 100,
            message: 'the same live bot should show gradual authoritative health recovery',
          }
        )
        .toBe(true);
    } catch (error) {
      console.error(
        'Bot regeneration evidence',
        JSON.stringify({ initialSnapshot, damagedSnapshot, result, samples })
      );
      throw error;
    }

    const recovered = recovery.pair;
    expect(recovered).toBeDefined();
    if (!recovered) {
      return;
    }
    expect(recovered.after.health).toBeGreaterThan(recovered.before.health);
    expect(recovered.after.health - recovered.before.health).toBeLessThan(2);
    expect(recovered.after.health).toBeLessThan(recovered.after.maxHealth);
    expect(recovered.before.lives).toBe(initialLives);
    expect(recovered.after.lives).toBe(initialLives);
    expect(recovered.before.maxHealth).toBe(recovered.after.maxHealth);
  },
  TestConfig.DEFAULT_TIMEOUT
);
