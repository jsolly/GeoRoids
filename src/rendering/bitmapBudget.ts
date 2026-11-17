/** Application-owned canvas backing estimate, not browser CPU/GPU memory or an OOM threshold. */
export const BITMAP_BUDGET_BYTES = 64 * 1024 * 1024;

type Allocation = { owner: string; bytes: number; policy: 'presentation' | 'cache' };
const allocations = new WeakMap<HTMLCanvasElement, Allocation>();
const owners = new Map<string, number>();
let liveBytes = 0;
let highWaterBytes = 0;
let deniedAllocations = 0;
let presentationBytes = 0;

function account(canvas: HTMLCanvasElement, next: Allocation): void {
  const old = allocations.get(canvas);
  if (old) {
    liveBytes -= old.bytes;
    owners.set(old.owner, (owners.get(old.owner) ?? 0) - old.bytes);
    if (old.policy === 'presentation') {
      presentationBytes -= old.bytes;
    }
  }
  allocations.set(canvas, next);
  liveBytes += next.bytes;
  owners.set(next.owner, (owners.get(next.owner) ?? 0) + next.bytes);
  if (next.policy === 'presentation') {
    presentationBytes += next.bytes;
  }
  highWaterBytes = Math.max(highWaterBytes, liveBytes);
}

/** Resize credit replaces this canvas's old allocation. Presentation is mandatory and may exceed budget. */
export function resizeBitmap(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  owner: string,
  policy: Allocation['policy'] = 'presentation',
  reset = false
): boolean {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 0 ||
    height < 0 ||
    !Number.isSafeInteger(width * height * 4)
  ) {
    throw new Error('Invalid canvas bitmap dimensions');
  }
  const bytes = width * height * 4;
  const prior = allocations.get(canvas);
  if (
    !reset &&
    canvas.width === width &&
    canvas.height === height &&
    prior?.bytes === bytes &&
    prior.owner === owner &&
    prior.policy === policy
  ) {
    return true;
  }
  if (
    policy === 'cache' &&
    liveBytes - (allocations.get(canvas)?.bytes ?? 0) + bytes > BITMAP_BUDGET_BYTES
  ) {
    deniedAllocations++;
    releaseBitmap(canvas);
    return false;
  }
  try {
    // Free the old shape before changing both axes, avoiding an intermediate oversized bitmap.
    if (canvas.width !== width && canvas.height !== height) {
      canvas.width = 0;
      canvas.height = height;
      canvas.width = width;
    } else {
      if (reset || canvas.width !== width) {
        canvas.width = width;
      }
      if (reset || canvas.height !== height) {
        canvas.height = height;
      }
    }
    account(canvas, { owner, bytes: canvas.width * canvas.height * 4, policy });
    return true;
  } catch (error) {
    releaseBitmap(canvas);
    throw error;
  }
}

/** Owners call this before relinquishing a handle; the ledger never retains a DOM node. */
export function releaseBitmap(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
  const old = allocations.get(canvas);
  if (!old) {
    return;
  }
  liveBytes -= old.bytes;
  owners.set(old.owner, (owners.get(old.owner) ?? 0) - old.bytes);
  if (old.policy === 'presentation') {
    presentationBytes -= old.bytes;
  }
  allocations.delete(canvas);
}

export function readBitmapBudget() {
  return {
    estimate: 'owned-canvas-width-height-rgba8',
    budgetBytes: BITMAP_BUDGET_BYTES,
    policy: 'deny-optional-caches-admit-presentation',
    liveBytes,
    livePixels: liveBytes / 4,
    presentationBytes,
    cacheBytes: liveBytes - presentationBytes,
    highWaterBytes,
    highWaterPixels: highWaterBytes / 4,
    overBudgetBytes: Math.max(0, liveBytes - BITMAP_BUDGET_BYTES),
    deniedAllocations,
    owners: Object.fromEntries([...owners].filter(([, bytes]) => bytes > 0)),
  };
}
