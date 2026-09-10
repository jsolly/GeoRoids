import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

import { initTitleTerrain } from '../../../src/rendering/titleTerrain';

const originalViewport = { width: window.innerWidth, height: window.innerHeight };
const productionHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: originalViewport.width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: originalViewport.height,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
])('homepage paints labeled contours without stars at $width px', ({ width, height }) => {
  const dom = new window.DOMParser().parseFromString(productionHtml, 'text/html');
  vi.stubGlobal('document', dom);
  vi.stubGlobal('HTMLCanvasElement', window.HTMLCanvasElement);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  // Keep the static paint isolated; this test explicitly invokes the resize callback below.
  const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  const canvas = dom.querySelector<HTMLCanvasElement>('#title-terrain');
  expect(dom.querySelector('#title-starfield')).toBeNull();
  expect(canvas?.getAttribute('aria-hidden')).toBe('true');
  const context = canvas?.getContext('2d');
  if (!context) {
    throw new Error('Title canvas context missing');
  }
  const stroke = vi.spyOn(context, 'stroke');
  const moves = vi.spyOn(context, 'moveTo');
  const labels = vi.spyOn(context, 'fillText');
  const arc = vi.spyOn(context, 'arc');
  initTitleTerrain();
  expect(stroke.mock.calls.length).toBeGreaterThan(10);
  expect(labels.mock.calls.length).toBeGreaterThan(2);
  for (const [label] of labels.mock.calls) {
    expect(label).toMatch(/^-?\d+\.\d{2}$/);
  }
  expect(arc).not.toHaveBeenCalled();
  const paintCount = stroke.mock.calls.length;
  const resize = listen.mock.calls.find(([event]) => event === 'resize')?.[1];
  if (typeof resize !== 'function') {
    throw new Error('Missing resize renderer');
  }
  const originalMove = moves.mock.calls[0];
  if (!originalMove) {
    throw new Error('No homepage contour geometry rendered');
  }
  const originalMoveCount = moves.mock.calls.length;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width / 2 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height / 2 });
  resize.call(window, new Event('resize'));
  const resizedMove = moves.mock.calls[originalMoveCount];
  if (!resizedMove) {
    throw new Error('No resized homepage contour geometry rendered');
  }
  expect(resizedMove[0]).toBeCloseTo(originalMove[0] / 2, 5);
  expect(resizedMove[1]).toBeCloseTo(originalMove[1] / 2, 5);
  expect(stroke.mock.calls.length).toBe(paintCount * 2);
});
