import { describe, expect, test } from 'vitest';
import { GameStateManager } from '../../../src/core/services/GameStateManager';
import {
  describeDeathCause,
  formatDeathCauseForOverlay,
  formatGameOverText,
  isStaleGameOverSnapshot,
  preferDeathCause,
} from '../../../src/utils/deathCause';

const KNOWN_NAMES = new Map<string, string>([
  ['server-bot-0', 'Crimson Falcon'],
  ['client-friend', 'Nova Ranger'],
]);
const resolve = (id: string): string | undefined => KNOWN_NAMES.get(id);

describe('death cause attribution', () => {
  test('maps asteroid and boundary tokens to readable phrases', () => {
    expect(describeDeathCause('asteroid', resolve)).toBe('an asteroid');
    expect(describeDeathCause('boundary', resolve)).toBe('the arena wall');
  });

  test('resolves bot and player ids to names', () => {
    expect(describeDeathCause('server-bot-0', resolve)).toBe('Crimson Falcon');
    expect(describeDeathCause('client-friend', resolve)).toBe('Nova Ranger');
  });

  test('raw ids become a bot or another ship — never the id itself', () => {
    expect(describeDeathCause('client-stranger', resolve)).toBe('another ship');
    expect(describeDeathCause('server-bot-9')).toBe('a bot');
    expect(describeDeathCause('laser')).toBe('a laser');
    expect(describeDeathCause('player')).toBe('another ship');
  });

  test('unknown is only used when the attacker id is missing', () => {
    expect(describeDeathCause(undefined, resolve)).toBe('unknown');
    expect(describeDeathCause('', resolve)).toBe('unknown');
    expect(describeDeathCause('server-damage')).toBe('unknown');
  });
});

describe('game over copy', () => {
  test('omits killed-by-unknown when the cause is missing', () => {
    expect(formatGameOverText()).toBe('Game Over');
    expect(formatGameOverText('unknown')).toBe('Game Over');
  });

  test('includes a readable killer', () => {
    expect(formatGameOverText('an asteroid')).toBe('Game Over: You were killed by an asteroid');
    expect(formatGameOverText('boundary')).toBe('Game Over: You were killed by the arena wall');
    expect(formatGameOverText('Crimson Falcon')).toBe(
      'Game Over: You were killed by Crimson Falcon'
    );
    expect(formatGameOverText('server-bot-0', resolve)).toBe(
      'Game Over: You were killed by Crimson Falcon'
    );
    expect(formatGameOverText('server-bot-9')).toBe('Game Over: You were killed by a bot');
  });

  test('overlay never prints unknown or a raw entity id', () => {
    expect(formatDeathCauseForOverlay('unknown')).toBeUndefined();
    expect(formatDeathCauseForOverlay('server-damage')).toBeUndefined();
    expect(formatDeathCauseForOverlay('client-abc')).toBe('another ship');
    expect(formatGameOverText('unknown')).toBe('Game Over');
    expect(formatGameOverText('unknown').toLowerCase()).not.toContain('unknown');
  });
});

describe('preferDeathCause', () => {
  test('a specific killer wins over unknown or server-damage', () => {
    expect(preferDeathCause('unknown', 'boundary')).toBe('boundary');
    expect(preferDeathCause('server-damage', undefined, 'asteroid')).toBe('asteroid');
    expect(preferDeathCause('the arena wall', 'boundary')).toBe('the arena wall');
  });
});

describe('stale game-over snapshots', () => {
  test('treats a 3-to-0 drop with full health and no cause as leftover session state', () => {
    expect(
      isStaleGameOverSnapshot({
        prevLives: 3,
        nextLives: 0,
        health: 100,
        exploding: false,
      })
    ).toBe(true);
  });

  test('a leftover deathCause on a full-health 3-to-0 hull is still stale', () => {
    expect(
      isStaleGameOverSnapshot({
        prevLives: 3,
        nextLives: 0,
        deathCause: 'boundary',
        health: 100,
        exploding: false,
      })
    ).toBe(true);
  });

  test('does not ignore a real last-life death', () => {
    expect(
      isStaleGameOverSnapshot({
        prevLives: 1,
        nextLives: 0,
        deathCause: 'an asteroid',
        health: 0,
        exploding: true,
      })
    ).toBe(false);
    expect(
      isStaleGameOverSnapshot({
        prevLives: 1,
        nextLives: 0,
        health: 0,
        exploding: true,
      })
    ).toBe(false);
  });
});

describe('HUD overlay reset', () => {
  test('clearOverlay drops game-over text and kill banner', () => {
    const state = GameStateManager.getInstance();
    state.updateTextProperties('Game Over: You were killed by an asteroid', 1);
    state.setKillMessage('Crimson Falcon');

    state.clearOverlay();

    expect(state.getText()).toBe('');
    expect(state.getTextAlpha()).toBe(0);
    expect(state.hasKillMessage()).toBe(false);
  });
});
