import assert from 'node:assert/strict';
import type { ServerPerformanceSummary } from '../server/performanceMetrics';

function identity(summary: ServerPerformanceSummary) {
  const id = summary.window.id;
  assert(typeof id === 'string', 'Measured metric window has no identity');
  const separator = id.lastIndexOf(':');
  assert(separator > 0 && separator < id.length - 1, 'Invalid measured metric window identity');
  const sequence = Number(id.slice(separator + 1));
  assert(Number.isSafeInteger(sequence) && sequence >= 0, 'Invalid metric window sequence');
  return { id, prefix: id.slice(0, separator), sequence };
}

/** Retain finalized measurement windows independently of the production diagnostics ring. */
export class MeasuredMetricWindows {
  private readonly first: ReturnType<typeof identity>;
  private readonly startedAt: string;
  private readonly windows = new Map<string, ServerPerformanceSummary>();
  private finished = false;

  constructor(active: ServerPerformanceSummary) {
    assert(active.window.finalized === false, 'Measurement must start at the active metric window');
    this.first = identity(active);
    this.startedAt = active.window.startedAt;
  }

  collect(windows: readonly ServerPerformanceSummary[]): void {
    assert(!this.finished, 'Measured metric windows are already frozen');
    for (const summary of windows) {
      assert(summary.window.finalized === true, 'Measured metric window is not finalized');
      const key = identity(summary);
      assert.equal(key.prefix, this.first.prefix, 'Metric process changed during measurement');
      if (key.sequence >= this.first.sequence && !this.windows.has(key.id)) {
        this.windows.set(key.id, summary);
      }
    }
  }

  finish(final: ServerPerformanceSummary, retained: readonly ServerPerformanceSummary[]) {
    this.collect(retained);
    this.collect([final]);
    const last = identity(final);
    assert(last.sequence >= this.first.sequence, 'Final metric window precedes measurement');
    const closedWindows: ServerPerformanceSummary[] = [];
    let endedAt = Date.parse(this.startedAt);
    assert(Number.isFinite(endedAt), 'Invalid metric measurement boundary');
    for (let sequence = this.first.sequence; sequence <= last.sequence; sequence++) {
      const id = `${this.first.prefix}:${sequence}`;
      const summary = this.windows.get(id);
      assert(summary, `Incomplete measured metric coverage: missing window ${id}`);
      const window = summary.window;
      const start = Date.parse(window.startedAt);
      const end = Date.parse(window.endedAt);
      assert(Number.isFinite(start) && Number.isFinite(end) && end >= start);
      assert(start >= endedAt, 'Measured metric windows overlap or run backward');
      assert(Number.isFinite(window.durationMs) && window.durationMs >= 0);
      if (sequence === this.first.sequence) {
        assert.equal(window.startedAt, this.startedAt, 'First measured metric boundary changed');
      }
      closedWindows.push(summary);
      endedAt = end;
    }
    assert.equal(
      this.windows.size,
      closedWindows.length,
      'Post-measurement metric window captured'
    );
    this.finished = true;
    return {
      closedWindows: Object.freeze(closedWindows),
      metricWindowCoverage: {
        firstId: this.first.id,
        lastId: last.id,
        windowCount: closedWindows.length,
        startedAt: this.startedAt,
        endedAt: final.window.endedAt,
        durationMs: closedWindows.reduce((sum, row) => sum + row.window.durationMs, 0),
      },
    };
  }
}
