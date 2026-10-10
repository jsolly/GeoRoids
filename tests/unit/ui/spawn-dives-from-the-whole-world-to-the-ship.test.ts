import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import { mountSpawnFlyIn, playSpawnFlyIn } from '../../../src/ui/spawnFlyIn';

let gameArea: HTMLElement;
let canvas: HTMLCanvasElement;
let visible: boolean;
let dispose: () => void;
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
  canvas = document.createElement('canvas');
  canvas.id = 'spawn-fly-in';
  gameArea.append(canvas);
  dispose = mountSpawnFlyIn(canvas, (next) => {
    visible = next;
  });
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
  dispose();
  gameArea.remove();
  vi.restoreAllMocks();
});

function runFrameAt(ms: number): void {
  const frame = frames.shift();
  frame?.(performance.now() + ms);
}

test('any key skips the dive', () => {
  playSpawnFlyIn();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  expect(visible).toBe(false);
  expect(canvas.isConnected).toBe(true);
});

test('a tap skips the dive', () => {
  playSpawnFlyIn();
  window.dispatchEvent(new Event('pointerdown'));
  expect(visible).toBe(false);
  expect(canvas.isConnected).toBe(true);
});

test('the dive ends immediately if the pilot has no ship yet', () => {
  localShip = null;
  playSpawnFlyIn();
  runFrameAt(0);
  expect(visible).toBe(false);
  expect(canvas.isConnected).toBe(true);
});

test('a second join cancels the first dive and reuses the shell canvas', () => {
  playSpawnFlyIn();
  playSpawnFlyIn();
  expect(document.querySelectorAll('#spawn-fly-in')).toHaveLength(1);
  expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  expect(visible).toBe(true);
});

test('pilots who prefer reduced motion land directly in flight', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  playSpawnFlyIn();
  expect(visible).toBe(false);
  expect(canvas.isConnected).toBe(true);
});

test('unmount cancels the owned frame and detached input cannot restart the painter', () => {
  playSpawnFlyIn();
  dispose();
  expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
  expect(visible).toBe(false);
  const scheduled = frames.length;
  frames[0]?.(performance.now());
  playSpawnFlyIn();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  expect(frames).toHaveLength(scheduled);
  expect(canvas.isConnected).toBe(true);
});
