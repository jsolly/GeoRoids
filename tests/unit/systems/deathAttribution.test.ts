import { describe, expect, test } from 'vitest';
import { GameStateManager } from '../../../src/core/services/GameStateManager';
import { describeDeathCause, preferDeathCause } from '../../../src/utils/deathCause';

describe('death cause attribution', () => {
  test('maps asteroid, boundary, and ricochet tokens to readable phrases', () => {
    expect(describeDeathCause('asteroid')).toBe('an asteroid');
    expect(describeDeathCause('boundary')).toBe('the arena wall');
    expect(describeDeathCause('ricochet')).toBe('a ricochet');
  });

  test('unknown is only used when the attacker id is missing', () => {
    expect(describeDeathCause(undefined)).toBe('unknown');
    expect(describeDeathCause('')).toBe('unknown');
    expect(describeDeathCause('server-damage')).toBe('unknown');
  });
});

describe('preferDeathCause', () => {
  test('a specific cause wins over unknown or server-damage', () => {
    expect(preferDeathCause('unknown', 'boundary')).toBe('boundary');
    expect(preferDeathCause('server-damage', undefined, 'asteroid')).toBe('asteroid');
    expect(preferDeathCause('the arena wall', 'boundary')).toBe('the arena wall');
  });
});

describe('HUD overlay reset', () => {
  test('clearOverlay drops death text and delivery banner', () => {
    const state = GameStateManager.getInstance();
    state.updateTextProperties('You were killed by an asteroid', 1);
    state.setDeliveryMessage(300, 2);

    state.clearOverlay();

    expect(state.getText()).toBe('');
    expect(state.getTextAlpha()).toBe(0);
    expect(state.hasPickupMessage()).toBe(false);
  });
});
