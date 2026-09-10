import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DAMAGE, GAME } from '../../../../src/constants';
import { GameController } from '../../../../src/core/gameController';
import { GameStateManager } from '../../../../src/core/services/GameStateManager';
import { PlayerManager } from '../../../../src/entities/player/PlayerManager';
import { setPlayView, toggleScreen } from '../../../../src/ui/uiUtils';
import { GameServerWorld, type Pilot, useQuietServerConsole } from '../support/gameServerWorld';

useQuietServerConsole();

/** Overlay time in `GameController.gameOver` — long enough to read, not a stall. */
const GAME_OVER_OVERLAY_MS = 3500;

describe('Game-over returns to the menu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    GameController.getInstance().cancelPendingGameOver();
    GameStateManager.getInstance().setIsGameRunning(true);
    GameStateManager.getInstance().updateTextProperties('', 1);
    toggleScreen('start-screen', false);
    toggleScreen('gameArea', true);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    GameStateManager.getInstance().setIsGameRunning(false);
    GameStateManager.getInstance().updateTextProperties('', 1);
  });

  test('a known killer is shown — never "unknown"', () => {
    const controller = GameController.getInstance();
    controller.gameOver('the arena wall');

    const text = GameStateManager.getInstance().getText();
    expect(text).toBe('Game Over: You were killed by the arena wall');
    expect(text.toLowerCase()).not.toContain('unknown');
  });

  test('omitting a cause says Game Over, not killed-by-unknown', () => {
    GameController.getInstance().gameOver();

    const text = GameStateManager.getInstance().getText();
    expect(text).toBe('Game Over');
    expect(text.toLowerCase()).not.toContain('unknown');
  });

  test('the overlay is 3.5s — the game stops then, not after a long stall', async () => {
    GameController.getInstance().gameOver('boundary');

    expect(GameStateManager.getInstance().getIsGameRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(GAME_OVER_OVERLAY_MS - 1);
    expect(GameStateManager.getInstance().getIsGameRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(GameStateManager.getInstance().getIsGameRunning()).toBe(false);
  });

  test('the game-over menu returns to the start screen', () => {
    setPlayView(false);

    expect(document.getElementById('start-screen')?.style.display).toBe('block');
    expect(document.getElementById('gameArea')?.style.display).toBe('none');
  });

  test('a final death event with a real cause does not become unknown', () => {
    const controller = GameController.getInstance();
    controller.newGame('Ace');
    const local = PlayerManager.getInstance().getLocalPlayer();
    assert.ok(local, 'Expected the local player after newGame');

    window.dispatchEvent(
      new CustomEvent('playerDied', {
        detail: { playerId: local.id, deathCause: 'boundary', isGameOver: true },
      })
    );

    const text = GameStateManager.getInstance().getText();
    expect(text).toBe('Game Over: You were killed by the arena wall');
    expect(text.toLowerCase()).not.toContain('unknown');
  });

  test('an unknown event still names the wall from the local ship explode cause', () => {
    const controller = GameController.getInstance();
    controller.newGame('Ace');
    const local = PlayerManager.getInstance().getLocalPlayer();
    assert.ok(local, 'Expected the local player after newGame');
    local.deathCause = 'boundary';
    local.ship.lastExplodeCause = 'boundary';

    window.dispatchEvent(
      new CustomEvent('playerDied', {
        detail: { playerId: local.id, deathCause: 'unknown', isGameOver: true },
      })
    );

    const text = GameStateManager.getInstance().getText();
    expect(text).toBe('Game Over: You were killed by the arena wall');
    expect(text.toLowerCase()).not.toContain('unknown');
  });

  test('every killer token prints a phrase — never unknown or a raw id', () => {
    const cases: Array<[string, string]> = [
      ['boundary', 'the arena wall'],
      ['asteroid', 'an asteroid'],
      ['server-bot-0', 'a bot'],
      ['client-friend', 'another ship'],
      ['laser', 'a laser'],
    ];
    for (const [token, phrase] of cases) {
      GameController.getInstance().cancelPendingGameOver();
      GameController.getInstance().gameOver(token);
      const text = GameStateManager.getInstance().getText();
      expect(text).toBe(`Game Over: You were killed by ${phrase}`);
      expect(text.toLowerCase()).not.toContain('unknown');
      if (token.startsWith('server-') || token.startsWith('client-')) {
        expect(text).not.toContain(token);
      }
    }
  });
});

describe('Last life on the server', () => {
  let world: GameServerWorld;
  let ace: Pilot;

  beforeEach(() => {
    world = new GameServerWorld();
    ace = world.join('Ace');
    world.wearOffJoinInvulnerability();
    world.entity(ace).lives = 1;
  });

  afterEach(() => {
    world.dispose();
  });

  test('the killing blow spends the last life and names the attacker', () => {
    world.hitBoundary(ace);

    expect(world.entity(ace).lives).toBe(0);
    expect(world.entity(ace).health).toBe(0);
    expect(world.entity(ace).exploding).toBe(true);
    expect(ace.socket.lastReceived('playerKilled')?.data).toMatchObject({
      targetPlayerId: ace.id,
      attackerId: 'boundary',
    });
    expect(ace.socket.lastReceived('playerKilled')?.data).not.toMatchObject({
      attackerId: 'unknown',
    });
    expect(ace.socket.lastReceived('playerDamaged')?.data).toMatchObject({
      attackerId: 'boundary',
      remainingLives: 0,
    });
    expect(world.entity(ace).deathCause).toBe('boundary');
    expect(
      world.engine.getGameState().entities.find((entity) => entity.id === ace.id)
    ).toMatchObject({ deathCause: 'boundary', lives: 0 });
    expect(world.entity(ace).respawnTimer).toBeUndefined();
    expect(GAME.START_LIVES).toBe(3);
  });

  test('an asteroid kill stays on the snapshot until respawn', () => {
    world.entity(ace).lives = 2;
    world.entity(ace).health = DAMAGE.LASER_HIT;
    world.hitAsteroid(ace);
    expect(world.entity(ace).deathCause).toBe('asteroid');
    expect(
      world.engine.getGameState().entities.find((entity) => entity.id === ace.id)?.deathCause
    ).toBe('asteroid');

    world.tick(20);
    expect(world.entity(ace).health).toBeGreaterThan(0);
    expect(world.entity(ace).deathCause).toBeUndefined();
  });

  test('a bot kill stores the bot id on the snapshot', () => {
    const bot = world.engine.createBots(1)?.[0];
    assert.ok(bot, 'Expected the newly created bot');
    world.engine.handlePlayerDamage(ace.id, bot.id, world.entity(ace).health);
    expect(world.entity(ace).deathCause).toBe(bot.id);
    expect(
      world.engine.getGameState().entities.find((entity) => entity.id === ace.id)?.deathCause
    ).toBe(bot.id);
  });
});
