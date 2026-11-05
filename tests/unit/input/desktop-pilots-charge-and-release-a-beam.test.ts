import { afterEach, expect, test, vi } from 'vitest';
import { SHIP } from '../../../shared/constants/gameplay';
import { contourLockVelocity } from '../../../shared/contourLock';
import { ensureTerrain } from '../../../shared/terrainField';
import type { WeaponChargeAction } from '../../../shared-types';
import { Player } from '../../../src/entities/player/Player';
import { keyDown, keyUp } from '../../../src/input/keybindings';

afterEach(() => vi.restoreAllMocks());

test('holding F charges once, suppresses ordinary shots, then releases; death cancels', () => {
  const sendCharge = vi.fn<(action: WeaponChargeAction) => boolean>(() => true);
  const sendShoot = vi.fn();
  const player = new Player({
    id: 'pilot',
    name: 'Pilot',
    type: 'local',

    combatNetwork: { isConnected: true, sendCharge, sendShoot, sendAbility: () => true },
  });
  keyDown(new KeyboardEvent('keydown', { code: 'KeyF' }), player);
  keyDown(new KeyboardEvent('keydown', { code: 'KeyF', repeat: true }), player);
  keyDown(new KeyboardEvent('keydown', { code: 'Space' }), player);
  expect(sendCharge.mock.calls).toEqual([['start']]);
  expect(sendShoot).not.toHaveBeenCalled();
  keyUp(new KeyboardEvent('keyup', { code: 'KeyF' }), player);
  keyUp(new KeyboardEvent('keyup', { code: 'KeyF' }), player);
  expect(sendCharge.mock.calls).toEqual([['start'], ['release']]);
  keyDown(new KeyboardEvent('keydown', { code: 'KeyF' }), player);
  player.ship.explode();
  keyUp(new KeyboardEvent('keyup', { code: 'KeyF' }), player);
  expect(sendCharge.mock.calls).toEqual([['start'], ['release'], ['start'], ['cancel']]);
});

test('bracket keys use the same adjacent contour hop as touch without repeating or refilling tools', () => {
  const player = new Player({
    id: 'pilot',
    name: 'Pilot',
    type: 'local',

    combatNetwork: {
      isConnected: true,
      sendCharge: () => true,
      sendShoot: () => undefined,
      sendAbility: () => true,
    },
  });
  ensureTerrain();
  const ship = player.ship;
  ship.position = { x: -4995.842222553734, y: -4996.116910407352 };
  ship.contourLock = { height: 0.08, direction: 1 };
  ship.velocity = contourLockVelocity(ship.position, ship.contourLock, SHIP.MAX_VELOCITY) ?? {
    x: 0,
    y: 0,
  };
  ship.angle = Math.atan2(-ship.velocity.y, ship.velocity.x);
  ship.abilityCooldownFrames = 100;
  // This known rail needs two guided steps before its lower neighbor is reachable.
  for (let frame = 0; frame < 2; frame++) {
    ship.update();
  }
  keyDown(new KeyboardEvent('keydown', { code: 'BracketLeft' }), player);
  expect(ship.contourLock).toEqual({ height: 0, direction: 1 });
  const after = { ...ship.contourLock };
  keyDown(new KeyboardEvent('keydown', { code: 'BracketRight', repeat: true }), player);
  expect(ship.contourLock).toEqual(after);
  expect(ship.abilityCooldownFrames).toBe(98);
});
