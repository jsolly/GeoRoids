// @vitest-environment node
import { expect, test } from 'vitest';
import {
  classifyReadbackWarning,
  createClientConsoleDiagnostics,
} from '../../../benchmarks/client-console-diagnostics';
import { createCompletedPixelCaptures } from '../../support/completed-pixel-captures';

const GPU_WARNING =
  '[.WebGL-0x1340045c400]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels';
const CANVAS_WARNING =
  'Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true. See: https://html.spec.whatwg.org/multipage/canvas.html#concept-canvas-will-read-frequently';

test('timing benchmarks reject every console warning despite recognizable readback text', () => {
  for (const warning of [GPU_WARNING, CANVAS_WARNING, 'WebGL context is unstable']) {
    const recorder = createClientConsoleDiagnostics('timing', 0);
    recorder.warning(warning);
    expect(() => recorder.finish(0)).toThrow(`Timing context console warning: ${warning}`);
  }
  expect(createClientConsoleDiagnostics('timing', 0).finish(0)).toEqual({
    mode: 'timing',
    actualCaptures: 0,
    warningCount: 0,
    warningLimit: 0,
    limitsByType: { 'webgl-readback': 0, 'canvas-readback': 0 },
    warnings: [],
  });
});

test('observation receipts retain exact known readback messages separately from timing', () => {
  expect(classifyReadbackWarning(GPU_WARNING)).toBe('webgl-readback');
  expect(classifyReadbackWarning(CANVAS_WARNING)).toBe('canvas-readback');
  const recorder = createClientConsoleDiagnostics('observation', 2);
  const suppressedRepeat = `${GPU_WARNING} (this message will no longer repeat)`;
  for (const warning of [GPU_WARNING, CANVAS_WARNING, suppressedRepeat]) {
    recorder.warning(warning);
  }
  expect(recorder.finish(2)).toEqual({
    mode: 'observation',
    actualCaptures: 2,
    warningCount: 3,
    warningLimit: 4,
    limitsByType: { 'webgl-readback': 2, 'canvas-readback': 2 },
    warnings: [
      { mode: 'observation', kind: 'webgl-readback', message: GPU_WARNING },
      { mode: 'observation', kind: 'canvas-readback', message: CANVAS_WARNING },
      { mode: 'observation', kind: 'webgl-readback', message: suppressedRepeat },
    ],
  });
});

test('unknown warnings and readback floods fail instead of hiding in the observation allowance', () => {
  for (const warning of [
    'Canvas drawing failed',
    `unrelated warning: ${GPU_WARNING}`,
    `${CANVAS_WARNING} with unexpected suffix`,
    GPU_WARNING.replace('Performance', 'Error'),
  ]) {
    expect(classifyReadbackWarning(warning)).toBeUndefined();
    const recorder = createClientConsoleDiagnostics('observation', 2);
    recorder.warning(warning);
    expect(() => recorder.finish(2)).toThrow(`Unknown observation console warning: ${warning}`);
  }
  for (const warning of [GPU_WARNING, CANVAS_WARNING]) {
    const recorder = createClientConsoleDiagnostics('observation', 2);
    for (let index = 0; index < 1000; index++) {
      recorder.warning(warning);
    }
    expect(() => recorder.finish(2)).toThrow('readback warning budget exceeded');
  }
  const exhausted = createClientConsoleDiagnostics('observation', 1);
  exhausted.warning(GPU_WARNING);
  exhausted.warning(CANVAS_WARNING);
  exhausted.warning(GPU_WARNING);
  expect(() => exhausted.finish(1)).toThrow('readback warning budget exceeded');
});

test('warning budgets require actual completed captures and cannot borrow captures from timing', () => {
  const recorder = createClientConsoleDiagnostics('observation', 2);
  recorder.warning(GPU_WARNING);
  for (const actual of [0, 1, 3, -1, 0.5, Number.NaN]) {
    expect(() => recorder.finish(actual)).toThrow('actual observation captures');
  }
  expect(() => createClientConsoleDiagnostics('timing', 1)).toThrow('capture budget');
  expect(() => createClientConsoleDiagnostics('observation', 0)).toThrow('capture budget');
  expect(() => createClientConsoleDiagnostics('observation', Number.NaN)).toThrow('capture budget');
});

test('a failed pixel observation cannot admit an extra readback warning', () => {
  const captures = createCompletedPixelCaptures();
  expect(() =>
    captures.capture(() => {
      throw new Error('Pixel read failed');
    })
  ).toThrow('Pixel read failed');
  expect(captures.count()).toBe(0);
  expect(captures.capture(() => [29, 29, 41, 255])).toEqual([29, 29, 41, 255]);
  expect(captures.count()).toBe(1);
  const recorder = createClientConsoleDiagnostics('observation', captures.count());
  recorder.warning(GPU_WARNING);
  recorder.warning(GPU_WARNING);
  expect(() => recorder.finish(captures.count())).toThrow('readback warning budget exceeded');
});
