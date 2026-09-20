import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getExplosionSound, playExplosionSound } from '../../../src/audio/explosionSound';
import { getLaserSound, playLaserSound } from '../../../src/audio/gameSounds';
import { Sound, setSound } from '../../../src/audio/Sound';
import {
  bindGameAudio,
  isInViewport,
  planPositionalPlayback,
  resetGameAudio,
  volumeScaleForDistance,
} from '../../../src/audio/spatialAudio';
import { AUDIO } from '../../../src/constants';
import { LOCAL_STORAGE_KEYS } from '../../../src/constants/user-preferences';
import { Player } from '../../../src/entities/player/Player';
import { reconcilePlayerInput } from '../../../src/input/keybindings';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';

const listener = { x: 400, y: 300 };
const viewport = { width: 800, height: 600 };

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.soundOn, 'true');
  resetGameAudio();
});

afterEach(() => {
  resetGameAudio();
  vi.restoreAllMocks();
  localStorage.removeItem(LOCAL_STORAGE_KEYS.soundOn);
});

test('automatic thrust stays silent while firing still plays its sound', () => {
  bindGameAudio({ getListenerPosition: () => listener, getViewport: () => viewport });
  const player = new Player({
    id: 'silent-pilot',
    name: 'Pilot',
    type: 'local',
    input: new MockPlayerInput(),
  });
  player.ship.position = { ...listener };
  const play = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
  for (let frame = 0; frame < 60; frame++) {
    reconcilePlayerInput(player);
    player.ship.update();
  }
  expect(player.ship.thrusting).toBe(true);
  expect(play).not.toHaveBeenCalled();
  player.ship.shoot();
  expect(play).toHaveBeenCalledOnce();
});

test('sound with no position plays at full volume', () => {
  expect(planPositionalPlayback(undefined, listener, viewport, { requireViewport: true })).toEqual({
    shouldPlay: true,
    volumeScale: 1,
  });
});

test('sound with no listener plays at full volume', () => {
  expect(
    planPositionalPlayback({ x: 0, y: 0 }, undefined, viewport, { requireViewport: true })
  ).toEqual({
    shouldPlay: true,
    volumeScale: 1,
  });
});

test('explosion at the local ship is in the viewport at full volume', () => {
  expect(isInViewport(listener, listener, viewport)).toBe(true);
  expect(planPositionalPlayback(listener, listener, viewport, { requireViewport: true })).toEqual({
    shouldPlay: true,
    volumeScale: 1,
    offset: { x: 0, y: 0 },
  });
});

test('explosion inside the viewport far from the ship is quieter than a near explosion', () => {
  const farOnScreen = { x: listener.x + 300, y: listener.y };
  const plan = planPositionalPlayback(farOnScreen, listener, viewport, { requireViewport: true });
  expect(isInViewport(farOnScreen, listener, viewport)).toBe(true);
  expect(plan.shouldPlay).toBe(true);
  expect(plan.volumeScale).toBeGreaterThan(0);
  expect(plan.volumeScale).toBeLessThan(1);
  expect(plan.volumeScale).toBe(volumeScaleForDistance(300, Math.hypot(400, 300)));
});

test('explosion outside the viewport does not play', () => {
  const offScreen = { x: listener.x + 1000, y: listener.y };
  expect(isInViewport(offScreen, listener, viewport)).toBe(false);
  expect(planPositionalPlayback(offScreen, listener, viewport, { requireViewport: true })).toEqual({
    shouldPlay: false,
    volumeScale: 0,
  });
});

test('close world sounds are louder than far world sounds without viewport culling', () => {
  const near = planPositionalPlayback({ x: listener.x + 50, y: listener.y }, listener, viewport);
  const far = planPositionalPlayback({ x: listener.x + 400, y: listener.y }, listener, viewport);
  expect(near.shouldPlay).toBe(true);
  expect(far.shouldPlay).toBe(true);
  expect(near.volumeScale).toBeGreaterThan(far.volumeScale);
});

test('playExplosionSound skips off-viewport explosions and plays near ones', () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });

  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);

  playExplosionSound({ x: listener.x + 1000, y: listener.y });
  expect(playSpy).not.toHaveBeenCalled();

  playExplosionSound(listener);
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(playSpy).toHaveBeenCalledWith(1, { x: 0, y: 0 });
});

test('one explosion event uses the shared explosion sound instance', () => {
  expect(getExplosionSound()).toBe(getExplosionSound());
  expect(getExplosionSound()).toBeInstanceOf(Sound);
});

test('a second explode on the same ship does not play another sound', async () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });

  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
  const { Ship } = await import('../../../src/entities/ship/Ship');
  const ship = new Ship({ position: listener });
  ship.explode();
  ship.explode();
  expect(playSpy).toHaveBeenCalledTimes(1);
});

test('in-viewport explosions never drop below the audible floor', () => {
  const corner = { x: listener.x + 399, y: listener.y + 299 };
  const plan = planPositionalPlayback(corner, listener, viewport, { requireViewport: true });
  expect(plan.shouldPlay).toBe(true);
  expect(plan.volumeScale).toBeGreaterThanOrEqual(AUDIO.MIN_IN_VIEWPORT_VOLUME);
});

test('blush falloff stays warmer than linear nearby and softer at the edge', () => {
  const max = 1000;
  const near = volumeScaleForDistance(250, max);
  const far = volumeScaleForDistance(750, max);
  expect(near).toBeGreaterThan(1 - 250 / max);
  expect(far).toBeLessThan(1 - 750 / max);
});

test('playLaserSound skips off-viewport shots and plays near ones', () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });

  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);

  playLaserSound({ x: listener.x + 1000, y: listener.y });
  expect(playSpy).not.toHaveBeenCalled();

  playLaserSound(listener);
  expect(playSpy).toHaveBeenCalledTimes(1);
  expect(playSpy).toHaveBeenCalledWith(1, { x: 0, y: 0 });
});

test('laser and explosion share Sound.play so Sound-off mutes both', () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });
  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);

  setSound(false);
  playExplosionSound(listener);
  playLaserSound(listener);

  expect(playSpy).not.toHaveBeenCalled();
});

test('every laser uses the same laser sound instance', () => {
  expect(getLaserSound()).toBe(getLaserSound());
  expect(getLaserSound()).toBeInstanceOf(Sound);
});

test('server exploding flag plays once for a remote and a second update does not', () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });
  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
  const remote = new Player({
    id: 'remote-1',
    name: 'Remote',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  remote.ship.position = listener;

  remote.updateFromServer({ health: 0, exploding: true, deathCause: 'asteroid' });
  remote.updateFromServer({ health: 0, exploding: true, deathCause: 'asteroid' });

  expect(remote.ship.exploding).toBe(true);
  expect(playSpy).toHaveBeenCalledTimes(1);
});

test('health drop and exploding flag together still play only one explosion', () => {
  bindGameAudio({
    getListenerPosition: () => listener,
    getViewport: () => viewport,
  });
  const playSpy = vi.spyOn(Sound.prototype, 'play').mockResolvedValue(undefined);
  const remote = new Player({
    id: 'remote-1',
    name: 'Remote',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  remote.ship.position = listener;
  remote.ship.health = 100;

  remote.updateFromServer({ health: 0, exploding: true });

  expect(playSpy).toHaveBeenCalledTimes(1);
});

test('muted firing leaves idle media untouched across simulation steps', () => {
  setSound(false);
  const laserPlay = vi.spyOn(getLaserSound(), 'play');
  for (let frame = 0; frame < 60; frame++) {
    playLaserSound();
  }
  expect(laserPlay).not.toHaveBeenCalled();
});

test('directions stay relative to the listener as both move across world sectors', () => {
  const source = { x: 9000, y: -3000 };
  const pilot = { x: 8800, y: -3100 };
  const plan = planPositionalPlayback(source, pilot, viewport);
  expect(plan.offset).toEqual({ x: 200, y: 100 });
  const moved = planPositionalPlayback(source, { x: 9200, y: -2900 }, viewport);
  expect(moved.offset).toEqual({ x: -200, y: -100 });
  expect(moved.volumeScale).toBe(plan.volumeScale);
});
