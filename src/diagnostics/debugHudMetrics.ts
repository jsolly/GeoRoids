/** Last-known Debug HUD samples, also included in explicit diagnostics captures. */

const FPS_WINDOW_MS = 1000;
const frameIntervals = new Float64Array(512);

let firstFrame = 0;
let frameCount = 0;
let frameElapsedMs = 0;
let pendingPing: { probeId: number; sentAt: number } | undefined;
let lastRttMs = Number.NaN;
let lastSnapshotSequence = 0;
let lastSnapshotAt = Number.NaN;

export function noteDebugPingSent(probeId: number, now: number): void {
  pendingPing = { probeId, sentAt: now };
}

export function noteDebugPong(probeId: unknown, now: number): void {
  if (
    pendingPing === undefined ||
    probeId !== pendingPing.probeId ||
    !Number.isFinite(now) ||
    now < pendingPing.sentAt
  ) {
    return;
  }
  lastRttMs = now - pendingPing.sentAt;
  pendingPing = undefined;
}

export function noteDebugSnapshot(sequence: number, now: number): void {
  lastSnapshotSequence = sequence;
  lastSnapshotAt = now;
}

export function noteDebugFrame(dtMs: number): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    return;
  }
  if (frameCount === frameIntervals.length) {
    frameElapsedMs -= frameIntervals[firstFrame] ?? 0;
    firstFrame = (firstFrame + 1) % frameIntervals.length;
    frameCount--;
  }
  frameIntervals[(firstFrame + frameCount) % frameIntervals.length] = dtMs;
  frameCount++;
  frameElapsedMs += dtMs;
  // Keep a complete foreground interval at the window boundary, including long stalls.
  while (frameCount > 1) {
    const oldest = frameIntervals[firstFrame] ?? 0;
    if (frameElapsedMs - oldest < FPS_WINDOW_MS) {
      break;
    }
    frameElapsedMs -= oldest;
    firstFrame = (firstFrame + 1) % frameIntervals.length;
    frameCount--;
  }
}

export function resetDebugHudSession(): void {
  pendingPing = undefined;
  lastRttMs = Number.NaN;
  lastSnapshotSequence = 0;
  lastSnapshotAt = Number.NaN;
}

export function resetDebugHudMetricsForTests(): void {
  firstFrame = 0;
  frameCount = 0;
  frameElapsedMs = 0;
  resetDebugHudSession();
}

export function readDebugHudMetrics(now: number): {
  fps: number | undefined;
  rttMs: number | undefined;
  snapshotSequence: number | undefined;
  snapshotAgeMs: number | undefined;
} {
  return {
    fps: frameCount > 0 ? Math.round((1000 * frameCount) / frameElapsedMs) : undefined,
    rttMs: Number.isFinite(lastRttMs) ? Math.round(lastRttMs) : undefined,
    snapshotSequence: lastSnapshotSequence > 0 ? lastSnapshotSequence : undefined,
    snapshotAgeMs:
      Number.isFinite(lastSnapshotAt) && now >= lastSnapshotAt
        ? Math.round(now - lastSnapshotAt)
        : undefined,
  };
}

export function shortReleaseId(id: string | undefined): string {
  return id != null && id !== '' ? id.slice(0, 7) : '—';
}
