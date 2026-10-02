export const GPU_WORK_COUNTERS = [
  'drawCalls',
  'geometryUploads',
  'uploadedBytes',
  'submittedStars',
  'submittedSegments',
  'nativeContourSegments',
  'rearBlits',
  'nativeStars',
  'nativeStarRects',
  'rearTextureUploads',
  'rearTextureUploadBytes',
] as const;

type GpuWorkCounters = Record<(typeof GPU_WORK_COUNTERS)[number], number>;

function readyStats(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('state' in value) ||
    value.state !== 'ready'
  ) {
    throw new Error('GPU observation has no ready resources');
  }
  return value;
}

function counter(stats: object, name: string): number {
  const value: unknown = Reflect.get(stats, name);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GPU observation has invalid ${name}`);
  }
  return value;
}

/** Capture by value before render; later last-frame stats cannot replace this baseline. */
export function gpuFrameSequence(value: unknown): number {
  return counter(readyStats(value), 'frames');
}

/** Validate each actual render, including timing contexts, outside CPU timing boundaries. */
export function observeGpuRenderedFrame(before: number, value: unknown) {
  const stats = readyStats(value);
  const frames = counter(stats, 'frames');
  if (!Number.isSafeInteger(before) || before < 0 || frames - before !== 1) {
    throw new Error('Measured render must advance exactly one GPU frame');
  }
  const work: GpuWorkCounters = {
    drawCalls: counter(stats, 'drawCalls'),
    geometryUploads: counter(stats, 'geometryUploads'),
    uploadedBytes: counter(stats, 'uploadedBytes'),
    submittedStars: counter(stats, 'submittedStars'),
    submittedSegments: counter(stats, 'submittedSegments'),
    nativeContourSegments: counter(stats, 'nativeContourSegments'),
    rearBlits: counter(stats, 'rearBlits'),
    nativeStars: counter(stats, 'nativeStars'),
    nativeStarRects: counter(stats, 'nativeStarRects'),
    rearTextureUploads: counter(stats, 'rearTextureUploads'),
    rearTextureUploadBytes: counter(stats, 'rearTextureUploadBytes'),
  };
  if (Reflect.get(stats, 'workload') !== 'native-rear-gpu-contours') {
    throw new Error('GPU observation has an unsupported workload contract');
  }
  const rearBytes = counter(stats, 'rearTextureBytes');
  const contourMode: unknown = Reflect.get(stats, 'contourMode');
  if (contourMode !== 'gpu-capsules' && contourMode !== 'canvas-path') {
    throw new Error('GPU observation has an inactive contour painter');
  }
  const contourReason: unknown = Reflect.get(stats, 'contourReason');
  if (
    contourReason !== 'none' &&
    contourReason !== 'hairline' &&
    contourReason !== 'rotated-path-coverage'
  ) {
    throw new Error('GPU observation has an invalid contour painter reason');
  }
  if (
    contourMode === 'gpu-capsules'
      ? contourReason !== 'none'
      : contourReason !== 'hairline' && contourReason !== 'rotated-path-coverage'
  ) {
    throw new Error('GPU observation has an invalid contour painter reason');
  }
  if (
    work.drawCalls === 0 ||
    work.submittedStars !== 0 ||
    work.nativeStars === 0 ||
    work.nativeStarRects === 0 ||
    work.nativeStarRects > work.nativeStars ||
    work.rearTextureUploads !== 1 ||
    rearBytes === 0 ||
    work.rearTextureUploadBytes !== rearBytes ||
    work.rearBlits !== 1 ||
    (contourMode === 'gpu-capsules'
      ? work.submittedSegments === 0 || work.nativeContourSegments !== 0
      : work.nativeContourSegments === 0 ||
        work.submittedSegments !== 0 ||
        work.drawCalls !== 1 ||
        work.geometryUploads !== 0 ||
        work.uploadedBytes !== 0)
  ) {
    throw new Error('GPU frame lacks actual drawing, exclusive contour work or composition');
  }
  return { frames, contourMode, contourReason, work };
}
