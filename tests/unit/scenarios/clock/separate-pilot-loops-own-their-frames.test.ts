import { afterEach, expect, test, vi } from 'vitest';
import {
  EventLoop,
  type EventLoopHost,
  type EventLoopLifecycle,
} from '../../../../src/core/eventLoop';

const loops: EventLoop[] = [];
afterEach(() => {
  for (const loop of loops.splice(0)) {
    loop.dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function pilot() {
  const events = new EventTarget();
  const visibility = new EventTarget();
  const body = document.createElement('body');
  body.classList.add('debug-on');
  const hud = document.createElement('div');
  body.appendChild(hud);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  let hidden = false;
  const lifecycle = {
    getIsGameRunning: vi.fn(() => true),
    getCurrPlayer: () => undefined,
    resetPresentationClock: vi.fn(),
    updateGame: vi.fn(),
    renderGame: vi.fn(),
    stopAfterFrameFailure: vi.fn(),
    getNetworkManager: () => ({ isConnected: true, sendMessage: resync }),
  } satisfies EventLoopLifecycle;
  const resync = vi.fn(() => true);
  const paintDebugHud = vi.fn((now: number) => {
    hud.textContent = `Frame ${now}`;
  });
  const removedStart = vi.spyOn(events, 'removeEventListener');
  const removedVisibility = vi.spyOn(visibility, 'removeEventListener');
  const host = {
    window: events,
    document: {
      addEventListener: visibility.addEventListener.bind(visibility),
      removeEventListener: visibility.removeEventListener.bind(visibility),
      get hidden() {
        return hidden;
      },
      body,
    },
    now: () => 100,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
    paintDebugHud,
  } satisfies EventLoopHost;
  const mount = () => {
    const loop = new EventLoop(lifecycle, host);
    loops.push(loop);
    return loop;
  };
  const tick = (now: number) => {
    const next = frames.entries().next().value;
    if (!next) {
      throw new Error('Pilot has no scheduled frame');
    }
    frames.delete(next[0]);
    next[1](now);
  };
  const setHidden = (value: boolean) => {
    hidden = value;
    visibility.dispatchEvent(new Event('visibilitychange'));
  };
  return {
    events,
    frames,
    lifecycle,
    hud,
    paintDebugHud,
    removedStart,
    removedVisibility,
    resync,
    mount,
    tick,
    setHidden,
  };
}

test('two mounted pilots paint their own HUD and a disposed pilot cannot restart or steal frames', () => {
  const a = pilot();
  const b = pilot();
  const loopA = a.mount();
  b.mount();
  a.events.dispatchEvent(new Event('gameStart'));
  a.events.dispatchEvent(new Event('gameStart'));
  b.events.dispatchEvent(new Event('gameStart'));
  expect(a.frames.size).toBe(1);
  expect(b.frames.size).toBe(1);
  a.tick(116);
  expect(a.paintDebugHud).toHaveBeenCalledWith(116);
  expect(b.paintDebugHud).not.toHaveBeenCalled();
  expect(a.hud.textContent).toBe('Frame 116');
  expect(b.hud.textContent).toBe('');
  b.tick(120);
  expect(b.paintDebugHud).toHaveBeenCalledWith(120);
  expect(b.hud.textContent).toBe('Frame 120');
  expect(a.hud.textContent).toBe('Frame 116');
  const captured = a.frames.values().next().value;
  expect(captured).toBeDefined();
  loopA.dispose();
  loopA.dispose();
  expect(a.frames.size).toBe(0);
  expect(a.removedStart).toHaveBeenCalledOnce();
  expect(a.removedVisibility).toHaveBeenCalledOnce();
  captured?.(140);
  a.events.dispatchEvent(new Event('gameStart'));
  a.setHidden(false);
  expect(a.lifecycle.updateGame).toHaveBeenCalledOnce();
  expect(a.lifecycle.renderGame).toHaveBeenCalledOnce();
  expect(a.resync).not.toHaveBeenCalled();
  expect(a.frames.size).toBe(0);
  expect(a.hud.textContent).toBe('Frame 116');
  expect(b.hud.textContent).toBe('Frame 120');
  b.tick(140);
  expect(b.lifecycle.renderGame).toHaveBeenCalledTimes(2);
  expect(b.hud.textContent).toBe('Frame 140');
  expect(a.hud.textContent).toBe('Frame 116');
  a.mount();
  a.events.dispatchEvent(new Event('gameStart'));
  expect(a.frames.size).toBe(1);
  a.tick(150);
  expect(a.lifecycle.renderGame).toHaveBeenCalledTimes(2);
  expect(a.hud.textContent).toBe('Frame 150');
  expect(b.hud.textContent).toBe('Frame 140');
});

test('a hidden pilot resumes at zero delta through its own connection while the other keeps playing', () => {
  const a = pilot();
  const b = pilot();
  a.mount();
  b.mount();
  a.events.dispatchEvent(new Event('gameStart'));
  b.events.dispatchEvent(new Event('gameStart'));
  a.tick(116);
  a.setHidden(true);
  a.tick(60000);
  expect(a.lifecycle.updateGame).toHaveBeenCalledOnce();
  b.tick(132);
  a.setHidden(false);
  a.tick(60016);
  expect(a.lifecycle.updateGame).toHaveBeenLastCalledWith(0);
  expect(a.lifecycle.resetPresentationClock).toHaveBeenCalledOnce();
  expect(a.resync).toHaveBeenCalledWith({ type: 'snapshotResync', data: {} });
  expect(b.resync).not.toHaveBeenCalled();
  expect(b.lifecycle.updateGame).toHaveBeenCalledWith(32);
});

test('one pilot frame failure stops its lifecycle while another continues rendering', () => {
  const a = pilot();
  const b = pilot();
  a.mount();
  b.mount();
  a.lifecycle.renderGame.mockImplementation(() => {
    throw new Error('Pilot A draw failed');
  });
  a.events.dispatchEvent(new Event('gameStart'));
  b.events.dispatchEvent(new Event('gameStart'));
  a.tick(116);
  b.tick(116);
  expect(a.lifecycle.stopAfterFrameFailure).toHaveBeenCalledOnce();
  expect(a.frames.size).toBe(0);
  expect(b.lifecycle.stopAfterFrameFailure).not.toHaveBeenCalled();
  expect(b.lifecycle.renderGame).toHaveBeenCalledOnce();
  expect(b.frames.size).toBe(1);
});
