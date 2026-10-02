// @vitest-environment node
import { expect, test } from 'vitest';
import {
  gpuFrameSequence,
  observeGpuRenderedFrame,
} from '../../../benchmarks/gpu-frame-observation';

function completedFrame(frames = 501) {
  return {
    state: 'ready',
    workload: 'native-rear-gpu-contours',
    frames,
    contourMode: 'gpu-capsules',
    contourReason: 'none',
    drawCalls: 12,
    geometryUploads: 0,
    uploadedBytes: 0,
    submittedStars: 0,
    submittedSegments: 200,
    nativeContourSegments: 0,
    rearBlits: 1,
    nativeStars: 80,
    nativeStarRects: 30,
    rearTextureBytes: 640_000,
    rearTextureUploads: 1,
    rearTextureUploadBytes: 640_000,
  };
}

test('a long benchmark warmup cannot hide a stale, skipped, or extra measured GPU render', () => {
  const warm = completedFrame(500);
  const before = gpuFrameSequence(warm);
  warm.frames = 501;
  expect(observeGpuRenderedFrame(before, warm).frames).toBe(501);
  expect(() => observeGpuRenderedFrame(before, completedFrame(500))).toThrow(
    'exactly one GPU frame'
  );
  expect(() => observeGpuRenderedFrame(before, completedFrame(502))).toThrow(
    'exactly one GPU frame'
  );
  expect(() => observeGpuRenderedFrame(before, completedFrame(499))).toThrow(
    'exactly one GPU frame'
  );
  expect(() => observeGpuRenderedFrame(-1, completedFrame(0))).toThrow();
});

test('each measured GPU frame must record native stars, one source upload and opaque blit, and its exclusive contour painter', () => {
  const gpu = completedFrame();
  expect(observeGpuRenderedFrame(500, gpu).contourMode).toBe('gpu-capsules');
  const native = {
    ...gpu,
    contourMode: 'canvas-path',
    contourReason: 'hairline',
    drawCalls: 1,
    submittedSegments: 0,
    nativeContourSegments: 200,
  };
  expect(observeGpuRenderedFrame(500, native).contourMode).toBe('canvas-path');
  expect(
    observeGpuRenderedFrame(500, { ...native, contourReason: 'rotated-path-coverage' })
      .contourReason
  ).toBe('rotated-path-coverage');
  for (const invalid of [
    { ...gpu, drawCalls: 0 },
    { ...gpu, submittedStars: 1 },
    { ...gpu, nativeStars: 0 },
    { ...gpu, nativeStarRects: 0 },
    { ...gpu, nativeStarRects: 81 },
    { ...gpu, rearTextureUploads: 0 },
    { ...gpu, rearTextureUploads: 2 },
    { ...gpu, rearTextureUploadBytes: 639_999 },
    { ...gpu, rearTextureBytes: 0 },
    { ...gpu, workload: 'legacy-gpu-stars' },
    { ...gpu, rearBlits: 0 },
    { ...gpu, rearBlits: 2 },
    { ...gpu, submittedSegments: 0 },
    { ...gpu, nativeContourSegments: 1 },
    { ...native, nativeContourSegments: 0 },
    { ...native, submittedSegments: 1 },
    { ...native, drawCalls: 2 },
    { ...native, geometryUploads: 1 },
    { ...native, uploadedBytes: 1 },
    { ...gpu, contourMode: 'none' },
    { ...gpu, contourMode: 'other' },
    { ...gpu, contourReason: undefined },
    { ...gpu, contourReason: 'hairline' },
    { ...native, contourReason: undefined },
    { ...native, contourReason: 'none' },
    { ...native, contourReason: 'other' },
  ]) {
    expect(() => observeGpuRenderedFrame(500, invalid)).toThrow();
  }
});

test('missing resources and malformed observed counters fail the benchmark boundary', () => {
  for (const invalid of [null, [], {}, { ...completedFrame(), state: 'context-lost' }]) {
    expect(() => gpuFrameSequence(invalid)).toThrow();
    expect(() => observeGpuRenderedFrame(500, invalid)).toThrow();
  }
  for (const name of [
    'frames',
    'drawCalls',
    'geometryUploads',
    'uploadedBytes',
    'submittedStars',
    'submittedSegments',
    'nativeContourSegments',
    'rearBlits',
    'nativeStars',
    'nativeStarRects',
    'rearTextureBytes',
    'rearTextureUploads',
    'rearTextureUploadBytes',
  ]) {
    for (const value of [undefined, -1, 0.5, Number.NaN, Infinity, 2 ** 53, '501']) {
      expect(() => observeGpuRenderedFrame(500, { ...completedFrame(), [name]: value })).toThrow();
      if (name === 'frames') {
        expect(() => gpuFrameSequence({ ...completedFrame(), [name]: value })).toThrow();
      }
    }
  }
});
