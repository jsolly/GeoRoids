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
  const labels = vi.spyOn(context, 'fillText');
  const arc = vi.spyOn(context, 'arc');
  initTitleTerrain();
  expect(stroke.mock.calls.length).toBeGreaterThan(10);
  expect(labels.mock.calls.length).toBeGreaterThan(2);
  for (const [label] of labels.mock.calls) {
    expect(label).toMatch(/^0\.\d{2}$/);
  }
  expect(arc).not.toHaveBeenCalled();
  const paintCount = stroke.mock.calls.length;
  const resize = listen.mock.calls.find(([event]) => event === 'resize')?.[1];
  if (typeof resize !== 'function') {
    throw new Error('Missing resize renderer');
  }
  resize.call(window, new Event('resize'));
  expect(stroke.mock.calls.length).toBe(paintCount * 2);
});
