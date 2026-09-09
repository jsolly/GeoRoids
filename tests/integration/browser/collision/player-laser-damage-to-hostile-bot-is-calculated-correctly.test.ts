import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks(__dirname);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test(
  'a player laser deals canonical damage to a hostile bot',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    const botUpdates: Array<{
      botId: string | undefined;
      health: number | undefined;
      ownerId: string | undefined;
      timestamp: number | undefined;
    }> = [];
    const shotOwners: unknown[] = [];
    const malformedFrames: string[] = [];
    const parseFrame = (payload: unknown, direction: 'sent' | 'received'): unknown => {
      try {
        return JSON.parse(String(payload));
      } catch (error) {
        malformedFrames.push(
          `${direction} frame was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
        return undefined;
      }
    };
    page.on('websocket', (socket) => {
      socket.on('framesent', ({ payload }) => {
        const message = parseFrame(payload, 'sent');
        if (isRecord(message) && message['type'] === 'shoot') {
          shotOwners.push(message['id']);
        }
      });
      socket.on('framereceived', ({ payload }) => {
        const message = parseFrame(payload, 'received');
        if (!isRecord(message) || message['type'] !== 'botUpdate') {
          return;
        }
        const data = message['data'];
        if (isRecord(data)) {
          botUpdates.push({
            botId: typeof data['botId'] === 'string' ? data['botId'] : undefined,
            health: typeof data['health'] === 'number' ? data['health'] : undefined,
            ownerId: typeof data['playerId'] === 'string' ? data['playerId'] : undefined,
            timestamp: typeof message['timestamp'] === 'number' ? message['timestamp'] : undefined,
          });
        }
      });
    });
    await game.bootGame();
    await game.waitForBots(1);

    const hostileBotId = await game.getHostileBotId();
    const bot = (await game.getBots()).find((candidate) => candidate.id === hostileBotId);
    expect(bot, 'an alive hostile bot should be available for laser damage').toBeDefined();
    if (!bot) {
      return;
    }
    const localPlayerId = await page.evaluate(() => {
      const gc = window.gameController;
      return gc?.getNetworkManager?.().getLocalPlayerId?.();
    });
    expect(localPlayerId, 'the local player must be joined before firing').toBeTruthy();
    const updateCountBeforeShot = botUpdates.length;

    // This helper creates a real local laser, waits for the authoritative pose
    // acknowledgement, and reports the observed hit. The server's existing
    // botUpdate broadcast is the accepted-hit evidence; it carries the raw
    // post-damage health before the browser's prediction can regenerate it.
    const result = await game.attackBotWithLasers(bot.id, 1);
    const healthBeforeShot = result.firstShotHealthBefore;

    await expect
      .poll(
        () =>
          botUpdates
            .slice(updateCountBeforeShot)
            .find(
              (update) =>
                update.botId === bot.id &&
                update.ownerId === 'server' &&
                update.health !== undefined &&
                update.health < healthBeforeShot
            ),
        { timeout: 5000, message: 'server should broadcast the accepted hostile bot laser hit' }
      )
      .toBeDefined();
    const damageUpdate = botUpdates
      .slice(updateCountBeforeShot)
      .find(
        (update) =>
          update.botId === bot.id &&
          update.ownerId === 'server' &&
          update.health !== undefined &&
          update.health < healthBeforeShot
      );
    expect(damageUpdate?.ownerId, 'the accepted bot update should come from the server owner').toBe(
      'server'
    );
    expect(healthBeforeShot - (damageUpdate?.health ?? healthBeforeShot)).toBeCloseTo(25, 0);
    expect(shotOwners, 'the wire shot should retain the local player as its owner').toEqual([
      localPlayerId,
    ]);
    expect(
      result.minHealthObserved,
      'the live bot view should show the health reduction'
    ).toBeLessThan(healthBeforeShot);
    expect(malformedFrames, 'all observed WebSocket frames must be valid JSON').toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
