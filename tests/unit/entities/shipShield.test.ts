import { describe, expect, test } from 'vitest';
import { GAME, SHIELD } from '../../../src/constants';
import {
  activateShield,
  applyShieldSnapshot,
  canActivateShield,
  clearShield,
  createShieldState,
  deactivateShield,
  isReadableShieldUp,
  isShieldBlockingLasers,
  laserCollisionRadius,
  maybeActivateBotShield,
  noteReadableShieldLaserHit,
  noteShieldLaserHit,
  requestShield,
  resolveCombatDamageSource,
  shieldCooldownFrames,
  shieldDurationFrames,
  shieldFlashFrames,
  shieldSnapshot,
  updateShield,
} from '../../../src/entities/ship/shipShield';

describe('shared ship shield state machine', () => {
  test('activate starts a timed bubble and blocks lasers only', () => {
    const state = createShieldState();
    expect(activateShield(state)).toBe(true);
    expect(state.shieldActive).toBe(true);
    expect(state.shieldTime).toBe(shieldDurationFrames());
    expect(isShieldBlockingLasers(state)).toBe(true);
  });

  test('Warden F shield lasts four seconds while other kits last two', () => {
    expect(shieldDurationFrames()).toBe(2 * GAME.FPS);
    expect(shieldDurationFrames('warden')).toBe(4 * GAME.FPS);

    const warden = createShieldState();
    expect(activateShield(warden, false, 'warden')).toBe(true);
    expect(warden.shieldTime).toBe(4 * GAME.FPS);
  });

  test('cannot activate while already up or on cooldown', () => {
    const state = createShieldState();
    expect(activateShield(state)).toBe(true);
    expect(canActivateShield(state)).toBe(false);
    expect(activateShield(state)).toBe(false);

    deactivateShield(state);
    expect(state.shieldActive).toBe(false);
    expect(state.shieldCooldown).toBe(shieldCooldownFrames());
    expect(activateShield(state)).toBe(false);
  });

  test('cannot activate while exploding', () => {
    const state = createShieldState();
    expect(activateShield(state, true)).toBe(false);
    expect(state.shieldActive).toBe(false);
  });

  test('duration expiry starts cooldown, then the shield can be reused', () => {
    const state = createShieldState();
    activateShield(state);

    for (let i = 0; i < shieldDurationFrames(); i++) {
      updateShield(state);
    }
    expect(state.shieldActive).toBe(false);
    expect(state.shieldCooldown).toBe(shieldCooldownFrames());
    expect(isShieldBlockingLasers(state)).toBe(false);

    for (let i = 0; i < shieldCooldownFrames(); i++) {
      updateShield(state);
    }
    expect(state.shieldCooldown).toBe(0);
    expect(activateShield(state)).toBe(true);
  });

  test('requestShield toggles on then off into cooldown', () => {
    const state = createShieldState();
    expect(requestShield(state, true)).toBe(true);
    expect(requestShield(state, true)).toBe(false);
    expect(requestShield(state, false)).toBe(true);
    expect(state.shieldActive).toBe(false);
    expect(state.shieldCooldown).toBeGreaterThan(0);
    expect(requestShield(state, false)).toBe(false);
  });

  test('laser hit flashes the ring without ending the bubble', () => {
    const state = createShieldState();
    activateShield(state);
    noteShieldLaserHit(state);
    expect(state.shieldFlashTime).toBe(Math.ceil(SHIELD.FLASH_SECONDS * GAME.FPS));
    expect(state.shieldActive).toBe(true);
  });

  test('shielded laser collision radius is larger than the hull', () => {
    const state = createShieldState();
    expect(laserCollisionRadius(10, state)).toBe(10);
    activateShield(state);
    expect(laserCollisionRadius(10, state)).toBe(10 * SHIELD.RADIUS_RATIO);
  });

  test('snapshot apply keeps two views of the same ship in agreement', () => {
    const server = createShieldState();
    activateShield(server);
    const client = createShieldState();
    applyShieldSnapshot(client, shieldSnapshot(server));
    expect(client).toEqual(server);
  });

  test('clearShield wipes active, cooldown, and flash', () => {
    const state = createShieldState();
    activateShield(state);
    noteShieldLaserHit(state);
    clearShield(state);
    expect(state).toEqual(createShieldState());
  });

  test('environmental attackers resolve as collision, player ids as laser', () => {
    expect(resolveCombatDamageSource('asteroid')).toBe('collision');
    expect(resolveCombatDamageSource('boundary')).toBe('collision');
    expect(resolveCombatDamageSource('player-1')).toBe('laser');
    expect(resolveCombatDamageSource('asteroid', 'laser')).toBe('laser');
  });

  test('a projected Warden shield uses the same rendered radius as F', () => {
    const state = { ...createShieldState(), shieldTimer: 12 };
    expect(isReadableShieldUp(state)).toBe(true);
    expect(isShieldBlockingLasers(state)).toBe(false);
    expect(laserCollisionRadius(10, state)).toBe(10 * SHIELD.RADIUS_RATIO);
    noteReadableShieldLaserHit(state);
    expect(state.shieldFlashTime).toBe(shieldFlashFrames());
  });

  test('a raised readable shield stays quiet until an enemy laser is recorded', () => {
    const state = { ...createShieldState(), shieldTimer: 12 };
    expect(state.shieldFlashTime).toBe(0);
    expect(isShieldBlockingLasers(state)).toBe(false);
  });
});

describe('player and bot share the same shield activation', () => {
  test('low-health bot uses activateShield, not a second implementation', () => {
    const bot = {
      ...createShieldState(),
      health: 40,
      maxHealth: 100,
      exploding: false,
      kitId: 'warden' as const,
    };
    expect(maybeActivateBotShield(bot, () => 0)).toBe(true);
    expect(bot.shieldActive).toBe(true);
    expect(bot.shieldTime).toBe(shieldDurationFrames('warden'));
  });

  test('healthy or exploding bots do not raise a shield', () => {
    const healthy = {
      ...createShieldState(),
      health: 90,
      maxHealth: 100,
      exploding: false,
    };
    expect(maybeActivateBotShield(healthy, () => 0)).toBe(false);

    const exploding = {
      ...createShieldState(),
      health: 10,
      maxHealth: 100,
      exploding: true,
    };
    expect(maybeActivateBotShield(exploding, () => 0)).toBe(false);
  });
});
