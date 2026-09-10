import { performance } from 'node:perf_hooks';

interface ServerClockSource {
  wallNow: () => number;
  monotonicNow: () => number;
}

const DEFAULT_SOURCE: ServerClockSource = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

/** Epoch-valued clock for deadlines that must survive wall-clock adjustments. */
export class ServerClock {
  private readonly wallOriginMs: number;
  private readonly monotonicOriginMs: number;
  private readonly monotonicNow: () => number;
  private lastMonotonicMs: number;

  constructor(source: ServerClockSource = DEFAULT_SOURCE) {
    const wallOriginMs = source.wallNow();
    const monotonicOriginMs = source.monotonicNow();
    if (
      !Number.isFinite(wallOriginMs) ||
      wallOriginMs < 0 ||
      !Number.isFinite(monotonicOriginMs) ||
      monotonicOriginMs < 0
    ) {
      throw new RangeError('Server clock requires finite non-negative origins');
    }
    this.wallOriginMs = wallOriginMs;
    this.monotonicOriginMs = monotonicOriginMs;
    this.monotonicNow = source.monotonicNow;
    this.lastMonotonicMs = monotonicOriginMs;
  }

  /** Return Unix epoch milliseconds while following monotonic elapsed time. */
  public now(): number {
    const monotonicNowMs = this.monotonicNow();
    if (!Number.isFinite(monotonicNowMs) || monotonicNowMs < this.lastMonotonicMs) {
      throw new RangeError('Server clock moved backwards');
    }
    this.lastMonotonicMs = monotonicNowMs;
    return Math.floor(this.wallOriginMs + monotonicNowMs - this.monotonicOriginMs);
  }
}
