import { expect, test } from 'vitest';
import { SnapshotDecoder } from '../../../../shared/snapshotProtocol';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type BotHealthSnapshot = {
  id: string;
  exploding: boolean;
  health: number;
};

test(
  'a player laser deals canonical damage to a hostile bot',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    const game = new GameInteractions(page);
    const shotOwners: unknown[] = [];
    const malformedFrames: string[] = [];
    const snapshotErrors: string[] = [];
    const currentBotSnapshots = new Map<string, BotHealthSnapshot>();
    const botSnapshots: BotHealthSnapshot[] = [];
    let trackedBotId: string | undefined;
    let healthBeforeFirstShot: number | undefined;
    let firstShotSampleIndex = 0;
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
      if (!/\/ws(?:\?|$)/.test(socket.url())) {
        return;
      }
      const decoder = new SnapshotDecoder();
      socket.on('framesent', ({ payload }) => {
        const message = parseFrame(payload, 'sent');
        if (isRecord(message) && message['type'] === 'shoot') {
          shotOwners.push(message['id']);
          if (healthBeforeFirstShot === undefined && trackedBotId) {
            const bot = currentBotSnapshots.get(trackedBotId);
            if (bot) {
              healthBeforeFirstShot = bot.health;
              firstShotSampleIndex = botSnapshots.length;
            }
          }
        }
      });
      socket.on('framereceived', ({ payload }) => {
        const message = parseFrame(payload, 'received');
        if (!isRecord(message)) {
          return;
        }
        if (message['type'] === 'joined') {
          decoder.reset();
          currentBotSnapshots.clear();
          botSnapshots.length = 0;
          healthBeforeFirstShot = undefined;
          firstShotSampleIndex = 0;
          return;
        }
        if (message['type'] !== 'snapshot') {
          return;
        }
        try {
          const snapshot = decoder.decode(message['data']);
          currentBotSnapshots.clear();
          for (const entity of snapshot.entities) {
            if (entity.type !== 'bot') {
              continue;
            }
            const bot: BotHealthSnapshot = {
              id: entity.id,
              exploding: entity.exploding,
              health: entity.health,
            };
            currentBotSnapshots.set(bot.id, bot);
            if (bot.id === trackedBotId) {
              botSnapshots.push(bot);
            }
          }
        } catch (error) {
          snapshotErrors.push(
            `authoritative snapshot could not be decoded: ${error instanceof Error ? error.message : String(error)}`
          );
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
    trackedBotId = bot.id;
    await expect
      .poll(() => currentBotSnapshots.get(bot.id), {
        timeout: 5000,
        message: 'the authoritative snapshot should contain the hostile bot',
      })
      .toBeDefined();
    const localPlayerId = await page.evaluate(() => {
      const gc = window.gameController;
      return gc?.getNetworkManager?.().getLocalPlayerId?.();
    });
    expect(localPlayerId, 'the local player must be joined before firing').toBeTruthy();

    // This helper creates a real local laser and waits for the authoritative
    // pose acknowledgement. The decoded snapshot stream below is the accepted
    // hit evidence and carries the server-owned post-damage health.
    await game.attackBotWithLasers(bot.id, 1);
    const healthBeforeShot = healthBeforeFirstShot;
    expect(healthBeforeShot, 'the first shot should have an authoritative health baseline').toEqual(
      expect.any(Number)
    );
    if (healthBeforeShot === undefined) {
      return;
    }

    await expect
      .poll(
        () =>
          botSnapshots
            .slice(firstShotSampleIndex)
            .find(
              (snapshot) =>
                snapshot.id === bot.id &&
                !snapshot.exploding &&
                snapshot.health > 0 &&
                snapshot.health < healthBeforeShot
            ),
        { timeout: 5000, message: 'decoded snapshots should show the accepted hostile bot hit' }
      )
      .toBeDefined();
    const damageSnapshot = botSnapshots
      .slice(firstShotSampleIndex)
      .find(
        (snapshot) =>
          snapshot.id === bot.id &&
          !snapshot.exploding &&
          snapshot.health > 0 &&
          snapshot.health < healthBeforeShot
      );
    expect(
      damageSnapshot,
      'an authoritative decoded snapshot should show bot damage'
    ).toBeDefined();
    if (!damageSnapshot) {
      return;
    }
    expect(healthBeforeShot - damageSnapshot.health).toBeCloseTo(25, 0);
    expect(shotOwners, 'the wire shot should retain the local player as its owner').toEqual([
      localPlayerId,
    ]);
    expect(malformedFrames, 'all observed WebSocket frames must be valid JSON').toEqual([]);
    expect(snapshotErrors, 'all authoritative snapshots must decode').toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
