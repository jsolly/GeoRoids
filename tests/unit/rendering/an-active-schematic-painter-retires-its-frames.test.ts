import { Buffer } from 'node:buffer';
import { afterEach, expect, test, vi } from 'vitest';
import { readBitmapBudget } from '../../../src/rendering/bitmapBudget';
import {
  mountShipSchematicCanvases,
  type SchematicSelection,
} from '../../../src/rendering/shipSchematicCanvas';

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
  const before = readBitmapBudget().liveBytes;
  const painter = mountShipSchematicCanvases(
    document.createElement('canvas'),
    document.createElement('canvas'),
    read
  );
  dispose = painter.dispose;
  expect(readBitmapBudget().liveBytes).toBeGreaterThan(before);
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
  expect(readBitmapBudget().liveBytes).toBe(before);
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

test('schematic frames retain backing stores while resizing and changing the selected tool', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const tick = (time: number) => {
    const entry = frames.entries().next().value;
    if (!entry) {
      throw new Error('Expected the active schematic animation frame');
    }
    frames.delete(entry[0]);
    entry[1](time);
  };
  const clock = vi.spyOn(performance, 'now').mockReturnValue(600);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1.5);
  let hullWidth = 320;
  let hullHeight = 180;
  let toolWidth = 220;
  let toolHeight = 80;
  const canvases = () => {
    const hull = document.createElement('canvas');
    const tool = document.createElement('canvas');
    vi.spyOn(hull, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, hullWidth, hullHeight)
    );
    vi.spyOn(tool, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 0, toolWidth, toolHeight)
    );
    return { hull, tool };
  };
  let selection: SchematicSelection = {
    kitId: 'scout',
    haulerUtility: 'tow_cable',
    scoutUtility: 'mineral_scan',
  };
  const { hull, tool } = canvases();
  const hullContext = hull.getContext('2d');
  const toolContext = tool.getContext('2d');
  if (!hullContext || !toolContext) {
    throw new Error('Expected native schematic drawing contexts');
  }
  const hullWidthSet = vi.spyOn(hull, 'width', 'set');
  const hullHeightSet = vi.spyOn(hull, 'height', 'set');
  const toolWidthSet = vi.spyOn(tool, 'width', 'set');
  const toolHeightSet = vi.spyOn(tool, 'height', 'set');
  const hullClear = vi.spyOn(hullContext, 'clearRect');
  const toolClear = vi.spyOn(toolContext, 'clearRect');
  const hullTransform = vi.spyOn(hullContext, 'setTransform');
  const toolTransform = vi.spyOn(toolContext, 'setTransform');
  const hullStroke = vi.spyOn(hullContext, 'stroke');
  const toolStroke = vi.spyOn(toolContext, 'stroke');
  const dimensionSetters = [hullWidthSet, hullHeightSet, toolWidthSet, toolHeightSet];
  const resetCalls = () => {
    for (const operation of [
      ...dimensionSetters,
      hullClear,
      toolClear,
      hullTransform,
      toolTransform,
      hullStroke,
      toolStroke,
    ]) {
      operation.mockClear();
    }
  };
  const painter = mountShipSchematicCanvases(hull, tool, () => selection);
  dispose = painter.dispose;
  expect([hull.width, hull.height, tool.width, tool.height]).toEqual([480, 270, 330, 120]);
  resetCalls();
  tick(600);
  expect(dimensionSetters.map((setter) => setter.mock.calls.length)).toEqual([0, 0, 0, 0]);
  expect(hullClear).toHaveBeenCalledExactlyOnceWith(0, 0, 320, 180);
  expect(toolClear).toHaveBeenCalledExactlyOnceWith(0, 0, 220, 80);
  expect(hullTransform).toHaveBeenCalledExactlyOnceWith(1.5, 0, 0, 1.5, 0, 0);
  expect(toolTransform).toHaveBeenCalledExactlyOnceWith(1.5, 0, 0, 1.5, 0, 0);
  expect(hullStroke).toHaveBeenCalled();
  expect(toolStroke).toHaveBeenCalled();

  // A fresh native context still resets on its initial sizing. Its pixels are
  // the independent witness that a retained context needs no resize reset.
  for (const [kitId, haulerUtility, time] of [
    ['hauler', 'resource_tap', 900],
    ['hauler', 'boost_coupling', 1500],
    ['scout', 'tow_cable', 600],
  ] as const) {
    const frameSelection = { ...selection, kitId, haulerUtility };
    selection = frameSelection;
    clock.mockReturnValue(time);
    resetCalls();
    painter.refresh();
    expect(dimensionSetters.map((setter) => setter.mock.calls.length)).toEqual([0, 0, 0, 0]);
    const fresh = canvases();
    const freshPainter = mountShipSchematicCanvases(fresh.hull, fresh.tool, () => frameSelection);
    try {
      for (const [retained, reference] of [
        [hull, fresh.hull],
        [tool, fresh.tool],
      ] as const) {
        const actualContext = retained.getContext('2d');
        const expectedContext = reference.getContext('2d');
        if (!actualContext || !expectedContext) {
          throw new Error('Expected native contexts for the schematic comparison');
        }
        const actual = actualContext.getImageData(0, 0, retained.width, retained.height).data;
        const expected = expectedContext.getImageData(0, 0, reference.width, reference.height).data;
        expect(actual.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
        expect(
          Buffer.from(actual).equals(Buffer.from(expected)),
          `${kitId}/${haulerUtility} retains the fresh context's pixels`
        ).toBe(true);
      }
    } finally {
      freshPainter.dispose();
    }
  }

  hullWidth = 321.4;
  resetCalls();
  tick(600);
  expect(dimensionSetters.map((setter) => setter.mock.calls.length)).toEqual([1, 0, 0, 0]);
  expect(hullWidthSet).toHaveBeenCalledExactlyOnceWith(482);
  expect(hullClear).toHaveBeenCalledExactlyOnceWith(0, 0, 482 / 1.5, 180);
  toolHeight = 81.4;
  resetCalls();
  tick(600);
  expect(dimensionSetters.map((setter) => setter.mock.calls.length)).toEqual([0, 0, 0, 1]);
  expect(toolHeightSet).toHaveBeenCalledExactlyOnceWith(122);
  expect(toolClear).toHaveBeenCalledExactlyOnceWith(0, 0, 220, 122 / 1.5);

  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3);
  resetCalls();
  tick(600);
  expect([hull.width, hull.height, tool.width, tool.height]).toEqual([642, 360, 440, 162]);
  // Both-axis growth first releases width, then sets the new height and width.
  expect(dimensionSetters.map((setter) => setter.mock.calls.length)).toEqual([2, 1, 2, 1]);
  expect(hullTransform).toHaveBeenCalledExactlyOnceWith(2, 0, 0, 2, 0, 0);
  expect(toolTransform).toHaveBeenCalledExactlyOnceWith(2, 0, 0, 2, 0, 0);

  vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(0);
  hullWidth = hullHeight = toolWidth = toolHeight = 0;
  resetCalls();
  tick(600);
  expect([hull.width, hull.height, tool.width, tool.height]).toEqual([640, 360, 220, 80]);
  expect(hullTransform).toHaveBeenCalledExactlyOnceWith(1, 0, 0, 1, 0, 0);
  expect(toolTransform).toHaveBeenCalledExactlyOnceWith(1, 0, 0, 1, 0, 0);
  expect(hullClear).toHaveBeenCalledExactlyOnceWith(0, 0, 640, 360);
  expect(toolClear).toHaveBeenCalledExactlyOnceWith(0, 0, 220, 80);
});
