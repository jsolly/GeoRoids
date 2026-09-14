import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { arrangeCrewField } from '../../utils/test-server-control';

const { browserManager } = createBrowserScenarioHooks();

type BotObservation = {
  id: string;
  name: string;
  kitId: string;
  x: number;
  y: number;
  score: number;
};

type AsteroidObservation = {
  id: string;
  surveyedBy: string[];
};

type AsteroidDestroyObservation = {
  asteroidId: string;
};

type ScoreUpdateObservation = {
  playerId: string;
  score: number;
};

type ProtocolObservation =
  | ({ kind: 'asteroidDestroy' } & AsteroidDestroyObservation)
  | ({ kind: 'scoreUpdate' } & ScoreUpdateObservation);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readAsteroidDestroy(message: unknown): AsteroidDestroyObservation | undefined {
  if (!isRecord(message) || message['type'] !== 'asteroidDestroy') {
    return undefined;
  }
  const data = message['data'];
  if (!isRecord(data)) {
    return undefined;
  }
  const asteroidId = data['asteroidId'];
  if (typeof asteroidId !== 'string') {
    return undefined;
  }
  return { asteroidId };
}

function readScoreUpdate(message: unknown): ScoreUpdateObservation | undefined {
  if (!isRecord(message) || message['type'] !== 'scoreUpdate') {
    return undefined;
  }
  const data = message['data'];
  if (!isRecord(data)) {
    return undefined;
  }
  const playerId = data['playerId'];
  const score = data['score'];
  if (typeof playerId !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
    return undefined;
  }
  return { playerId, score };
}

async function observeField(page: import('playwright').Page): Promise<{
  bots: BotObservation[];
  asteroids: AsteroidObservation[];
}> {
  return page.evaluate(() => {
    const controller = window.gameController;
    if (!controller) {
      throw new Error('Bot crew fixture requires a game controller');
    }
    return {
      bots: controller
        .getNetworkManager()
        .getAllPlayers()
        .filter((player) => player.type === 'bot')
        .map((player) => ({
          id: player.id,
          name: player.name,
          kitId: player.ship.kitId,
          x: player.ship.position.x,
          y: player.ship.position.y,
          score: player.score,
        })),
      asteroids: controller
        .getCurrRoidBelt()
        .getRoids()
        .map((rock) => ({
          id: rock.id,
          surveyedBy: [...(rock.surveyedBy ?? [])],
        })),
    };
  });
}

test(
  'existing bots mine rocks, run Surveyor scans, and stay on the shared crew field',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page unavailable');
    }
    const game = new GameInteractions(page);
    const protocol: ProtocolObservation[] = [];
    page.on('websocket', (socket) => {
      if (!/\/ws(?:\?|$)/.test(socket.url())) {
        return;
      }
      socket.on('framereceived', ({ payload }) => {
        const message: unknown = JSON.parse(String(payload));
        const destruction = readAsteroidDestroy(message);
        if (destruction) {
          protocol.push({ kind: 'asteroidDestroy', ...destruction });
        }
        const scoreUpdate = readScoreUpdate(message);
        if (scoreUpdate) {
          protocol.push({ kind: 'scoreUpdate', ...scoreUpdate });
        }
      });
    });
    await game.bootGame({ waitForCombatReady: false });
    await arrangeCrewField([await game.getLocalPlayerId()], 'bot-mining');
    await game.waitForBots(2);
    await expect
      .poll(async () =>
        (await game.getAsteroidPositions()).some((rock) => rock.id === 'crew-fixture-ore')
      )
      .toBe(true);
    const initial = await observeField(page);
    expect(initial.bots).toHaveLength(2);
    expect(initial.bots.every((bot) => bot.name.length > 0)).toBe(true);
    expect(initial.bots.some((bot) => bot.kitId === 'surveyor')).toBe(true);
    const initialBotScores = new Map(initial.bots.map((bot) => [bot.id, bot.score]));
    const botIds = new Set(initial.bots.map((bot) => bot.id));
    protocol.length = 0;

    const findBotMiningEvidence = ():
      | ({ asteroidId: string } & ScoreUpdateObservation)
      | undefined => {
      for (let index = 0; index < protocol.length; index += 1) {
        const event = protocol[index];
        if (event?.kind !== 'asteroidDestroy' || event.asteroidId !== 'crew-fixture-ore') {
          continue;
        }
        const neighbors = [protocol[index - 1], protocol[index + 1]];
        const scoreUpdate = neighbors.find(
          (neighbor): neighbor is { kind: 'scoreUpdate' } & ScoreUpdateObservation =>
            neighbor?.kind === 'scoreUpdate' &&
            botIds.has(neighbor.playerId) &&
            neighbor.score > (initialBotScores.get(neighbor.playerId) ?? 0)
        );
        if (scoreUpdate) {
          return { asteroidId: event.asteroidId, ...scoreUpdate };
        }
      }
      return undefined;
    };

    let sharedScan = false;
    await expect
      .poll(
        async () => {
          const current = await observeField(page);
          const moved = current.bots.some((bot) => {
            const start = initial.bots.find((candidate) => candidate.id === bot.id);
            return start !== undefined && Math.hypot(bot.x - start.x, bot.y - start.y) > 20;
          });
          // This scenario never fires from a human pilot. The server emits a
          // bot score update adjacent to its authoritative asteroid event, so
          // the pair proves bot mining without adding a test-only wire field.
          const botDestroy = findBotMiningEvidence();
          const mined = botDestroy !== undefined;
          const botScore =
            botDestroy !== undefined &&
            (current.bots.find((bot) => bot.id === botDestroy.playerId)?.score ?? 0) >=
              botDestroy.score;
          sharedScan ||= current.asteroids.some((rock) =>
            rock.surveyedBy.some((id) => botIds.has(id))
          );
          return { moved, mined, sharedScan, botScore };
        },
        {
          timeout: 15000,
          interval: 200,
          message: 'bots should move, destroy a rock, score it, and share a Surveyor scan',
        }
      )
      .toEqual({ moved: true, mined: true, sharedScan: true, botScore: true });

    const after = await observeField(page);
    const botDestruction = findBotMiningEvidence();
    expect(botDestruction).toBeDefined();
    if (!botDestruction) {
      throw new Error('Bot mining did not produce an authoritative asteroid destruction event');
    }
    expect(after.asteroids.some((rock) => rock.id === botDestruction.asteroidId)).toBe(false);
    expect(
      after.bots.find((bot) => bot.id === botDestruction.playerId)?.score
    ).toBeGreaterThanOrEqual(botDestruction.score);
    expect(after.bots.every((bot) => bot.kitId === 'surveyor' || bot.kitId === 'hauler')).toBe(
      true
    );
    expect(
      await page.evaluate(() =>
        window.gameController
          ?.getNetworkManager()
          .getAllPlayers()
          .every((player) => !('factionId' in player) && !('factionId' in player.ship))
      )
    ).toBe(true);
    expect(
      await page.evaluate(
        (botNames) => {
          const canvas = document.getElementById('gameCanvas');
          const controller = window.gameController;
          if (!canvas || !controller) {
            throw new Error('Bot crew fixture lost the rendered game');
          }
          const drawn: string[] = [];
          const original = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
            if (this.canvas === canvas) {
              drawn.push(text);
            }
            original.call(this, text, x, y, maxWidth);
          };
          try {
            controller.renderGame();
          } finally {
            CanvasRenderingContext2D.prototype.fillText = original;
          }
          return botNames.every((name) => drawn.includes(`${name} (bot)`));
        },
        after.bots.map((bot) => bot.name)
      )
    ).toBe(true);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
