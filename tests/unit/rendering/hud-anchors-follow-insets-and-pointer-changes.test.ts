import { afterEach, expect, test, vi } from 'vitest';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { hudLayoutForCanvas } from '../../../src/rendering/hud/hudLayout';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport = () => {};
let restoreProbe = () => {};

afterEach(() => {
  canvasManager.destroy();
  restoreViewport();
  restoreProbe();
  vi.restoreAllMocks();
});

test('unchanged viewport dimensions refresh inset and pointer anchors and release queued work on restart', () => {
  restoreViewport = setWindowViewport(1024, 768);
  const probe = document.querySelector('#safe-area-probe');
  if (!(probe instanceof HTMLElement)) {
    throw new Error('Expected production safe-area probe');
  }
  const previousStyle = probe.style.cssText;
  restoreProbe = () => {
    probe.style.cssText = previousStyle;
  };
  probe.style.padding = '47px 0px 34px 0px';
  let coarse = true;
  const media = new Map<string, MediaQueryList>();
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    let result = media.get(query);
    if (!result) {
      result = Object.assign(new window.EventTarget(), {
        matches: false,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
      });
      Object.defineProperty(result, 'matches', {
        get: () => query === '(pointer: coarse)' && coarse,
      });
      media.set(query, result);
    }
    return result;
  });
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });
  const styles = vi.spyOn(window, 'getComputedStyle');
  const layout = () => hudLayoutForCanvas(canvasManager.getViewportSize());
  const flush = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) {
      callback(0);
    }
  };

  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(layout().balance.y).toBe(55);
  const initialStyleReads = styles.mock.calls.length;
  for (let frame = 0; frame < 120; frame++) {
    layout();
  }
  expect(styles).toHaveBeenCalledTimes(initialStyleReads);

  probe.style.paddingTop = '12px';
  window.dispatchEvent(new Event('resize'));
  window.dispatchEvent(new Event('resize'));
  expect(callbacks.size).toBe(1);
  flush();
  expect(layout().balance.y).toBe(20);
  expect(canvasManager.getViewportSize()).toEqual({ width: 1024, height: 768 });
  expect(styles).toHaveBeenCalledTimes(initialStyleReads + 1);

  coarse = false;
  media.get('(pointer: coarse)')?.dispatchEvent(new Event('change'));
  flush();
  expect(layout().leaderboard.maxRows).toBe(10);
  coarse = true;
  media.get('(pointer: coarse)')?.dispatchEvent(new Event('change'));
  flush();
  expect(layout().leaderboard.maxRows).toBe(3);

  window.dispatchEvent(new Event('resize'));
  expect(callbacks.size).toBe(1);
  canvasManager.destroy();
  expect(callbacks.size).toBe(0);
  window.dispatchEvent(new Event('resize'));
  media.get('(pointer: coarse)')?.dispatchEvent(new Event('change'));
  expect(callbacks.size).toBe(0);
  probe.style.paddingTop = '60px';
  canvasManager.initialize(document.querySelector<HTMLCanvasElement>('#gameCanvas'));
  expect(layout().balance.y).toBe(68);
  window.dispatchEvent(new Event('resize'));
  expect(callbacks.size).toBe(1);
});
