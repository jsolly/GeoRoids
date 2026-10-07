import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import { playSpawnFlyIn } from '../../../src/ui/spawnFlyIn';

let gameArea: HTMLElement;
let frames: FrameRequestCallback[];
let localShip: { position: { x: number; y: number } } | null;

beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

beforeEach(() => {
  frames = [];
  localShip = { position: { x: 30_000, y: -12_000 } };
  gameArea = document.createElement('div');
  gameArea.id = 'gameArea';
  document.body.append(gameArea);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
  vi.spyOn(PlayerManager.getInstance(), 'getLocalPlayer').mockImplementation(
    () => (localShip ? { ship: localShip } : null) as ReturnType<PlayerManager['getLocalPlayer']>
  );
});
afterEach(() => {
  document.querySelector('#spawn-fly-in')?.remove();
  gameArea.remove();
  vi.restoreAllMocks();
});

function overlay(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('#spawn-fly-in');
}

function runFrameAt(ms: number): void {
  const frame = frames.shift();
  frame?.(performance.now() + ms);
}

test('any key skips the dive', () => {
  playSpawnFlyIn();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  expect(overlay()).toBeNull();
});

test('a tap skips the dive', () => {
  playSpawnFlyIn();
  window.dispatchEvent(new Event('pointerdown'));
  expect(overlay()).toBeNull();
});

test('the dive ends immediately if the pilot has no ship yet', () => {
  localShip = null;
  playSpawnFlyIn();
  runFrameAt(0);
  expect(overlay()).toBeNull();
});

test('a second join replaces the first dive with a single overlay', () => {
  playSpawnFlyIn();
  playSpawnFlyIn();
  expect(document.querySelectorAll('#spawn-fly-in')).toHaveLength(1);
});

test('pilots who prefer reduced motion land directly in flight', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  playSpawnFlyIn();
  expect(overlay()).toBeNull();
});
