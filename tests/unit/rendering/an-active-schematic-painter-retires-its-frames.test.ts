import { afterEach, expect, test, vi } from 'vitest';
import { mountShipSchematicCanvases } from '../../../src/rendering/shipSchematicCanvas';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('an active schematic pauses while hidden or reduced-motion and disposes every callback', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const media = new EventTarget();
  let reduced = false;
  Object.defineProperty(media, 'matches', { get: () => reduced });
  vi.stubGlobal('matchMedia', () => media);
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect = disconnect;
    }
  );
  const read = vi.fn(() => ({
    kitId: 'hauler' as const,
    haulerUtility: 'tow_cable' as const,
    scoutUtility: 'mineral_scan' as const,
  }));
  const painter = mountShipSchematicCanvases(
    document.createElement('canvas'),
    document.createElement('canvas'),
    read
  );
  dispose = painter.dispose;
  expect(read).toHaveBeenCalledOnce();
  expect(frames.size).toBe(1);
  const lateFrame = [...frames.values()][0];
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(frames.size).toBe(0);
  expect(read).toHaveBeenCalledOnce();
  hidden = false;
  reduced = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(read).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
  painter.refresh();
  expect(read).toHaveBeenCalledTimes(3);
  reduced = false;
  media.dispatchEvent(new Event('change'));
  expect(read).toHaveBeenCalledTimes(4);
  expect(frames.size).toBe(1);
  painter.dispose();
  painter.dispose();
  window.dispatchEvent(new Event('resize'));
  media.dispatchEvent(new Event('change'));
  document.dispatchEvent(new Event('visibilitychange'));
  lateFrame?.(1000);
  painter.refresh();
  expect(read).toHaveBeenCalledTimes(4);
  expect(frames.size).toBe(0);
  expect(disconnect).toHaveBeenCalledOnce();
});

test('a failed initial schematic paint unwinds listeners before retry', () => {
  const hull = document.createElement('canvas');
  const read = vi.fn(() => ({
    kitId: 'scout' as const,
    haulerUtility: 'tow_cable' as const,
    scoutUtility: 'mineral_scan' as const,
  }));
  const context = vi.spyOn(hull, 'getContext').mockImplementation(() => {
    throw new Error('Canvas failed');
  });
  expect(() => mountShipSchematicCanvases(hull, document.createElement('canvas'), read)).toThrow(
    'Canvas failed'
  );
  context.mockRestore();
  window.dispatchEvent(new Event('resize'));
  expect(read).toHaveBeenCalledOnce();
  const painter = mountShipSchematicCanvases(hull, document.createElement('canvas'), read);
  dispose = painter.dispose;
  expect(read).toHaveBeenCalledTimes(2);
});
