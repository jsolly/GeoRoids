import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

describe('local player game-over state', () => {
  let player: Player;
  const deaths: Array<{ playerId: string; deathCause: string; isGameOver: boolean }> = [];
  const onPlayerDied = (event: Event): void => {
    const detail = (
      event as CustomEvent<{ playerId: string; deathCause: string; isGameOver: boolean }>
    ).detail;
    deaths.push(detail);
  };

  beforeEach(() => {
    deaths.length = 0;
    player = new Player({
      id: 'local-player',
      name: 'Local Player',
      type: 'local',
      input: new MockPlayerInput(),
    });
    window.addEventListener('playerDied', onPlayerDied);
  });

  afterEach(() => {
    window.removeEventListener('playerDied', onPlayerDied);
  });

  test('uses deathCause from the same snapshot as the life loss', () => {
    player.updateFromServer({
      lives: 2,
      deathCause: 'an asteroid',
      health: 0,
      exploding: true,
    });

    expect(player.deathCause).toBe('an asteroid');
    expect(deaths).toEqual([
      { playerId: 'local-player', deathCause: 'an asteroid', isGameOver: false },
    ]);
  });

  test.each([
    ['asteroid', 'asteroid'],
    ['boundary', 'boundary'],
    ['server-bot-0', 'server-bot-0'],
    ['client-friend', 'client-friend'],
  ] as const)('snapshot token %s is kept on playerDied', (token, expected) => {
    deaths.length = 0;
    player.lives = 1;
    delete player.deathCause;
    delete player.ship.lastExplodeCause;
    player.ship.position = { x: 0, y: 0 };
    player.updateFromServer({
      lives: 0,
      deathCause: token,
      health: 0,
      exploding: true,
    });
    expect(deaths).toEqual([{ playerId: 'local-player', deathCause: expected, isGameOver: true }]);
  });

  test('ignores a server heal while lives are 0', () => {
    player.lives = 0;
    player.ship.health = 0;
    player.ship.exploding = true;

    player.updateFromServer({
      lives: 0,
      health: player.ship.maxHealth,
      exploding: false,
    });

    expect(player.ship.health).toBe(0);
    expect(player.lives).toBe(0);
  });

  test('does not fire unknown game-over from a leftover 0-life snapshot on a fresh player', () => {
    player.updateFromServer({
      lives: 0,
      health: 100,
      exploding: false,
    });

    expect(player.lives).toBe(3);
    expect(deaths).toEqual([]);
    expect(player.ship.health).toBe(100);
  });
});
