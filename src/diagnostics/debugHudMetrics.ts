/** Last-known Debug HUD samples. On-screen only — never forwarded to Railway. */

const FPS_BLEND = 0.18;
const MAX_FRAME_MS = 250;

let fps = Number.NaN;
let lastPingSentAt = Number.NaN;
let lastRttMs = Number.NaN;
let lastSnapshotSequence = 0;
let lastSnapshotAt = Number.NaN;

export function noteDebugPingSent(now: number): void {
  lastPingSentAt = now;
}

export function noteDebugPong(now: number): void {
  if (Number.isFinite(lastPingSentAt) && now >= lastPingSentAt) {
    lastRttMs = now - lastPingSentAt;
  }
}

export function noteDebugSnapshot(sequence: number, now: number): void {
  lastSnapshotSequence = sequence;
  lastSnapshotAt = now;
}

export function noteDebugFrame(dtMs: number): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > MAX_FRAME_MS) {
    return;
  }
  const instant = 1000 / dtMs;
  fps = Number.isFinite(fps) ? fps + (instant - fps) * FPS_BLEND : instant;
}

export function resetDebugHudSession(): void {
  lastPingSentAt = Number.NaN;
  lastRttMs = Number.NaN;
  lastSnapshotSequence = 0;
  lastSnapshotAt = Number.NaN;
}

export function resetDebugHudMetricsForTests(): void {
  fps = Number.NaN;
  resetDebugHudSession();
}

export function readDebugHudMetrics(now: number): {
  fps: number | undefined;
  rttMs: number | undefined;
  snapshotSequence: number | undefined;
  snapshotAgeMs: number | undefined;
} {
  return {
    fps: Number.isFinite(fps) ? Math.round(fps) : undefined,
    rttMs: Number.isFinite(lastRttMs) ? Math.round(lastRttMs) : undefined,
    snapshotSequence: lastSnapshotSequence > 0 ? lastSnapshotSequence : undefined,
    snapshotAgeMs:
      Number.isFinite(lastSnapshotAt) && now >= lastSnapshotAt
        ? Math.round(now - lastSnapshotAt)
        : undefined,
  };
}

export function shortReleaseId(id: string | undefined): string {
  if (!id || id === 'unknown') {
    return '—';
  }
  if (id === 'dev') {
    return 'dev';
  }
  return id.length <= 7 ? id : id.slice(0, 7);
}
