import { afterEach, expect, test, vi } from 'vitest';
import { startRecordingHeartbeat } from '../../../src/diagnostics/recordingHeartbeat';

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
  tick(sequence: number, monotonicMs: number, wallMs = monotonicMs + 10000) {
    this.onmessage?.(
      new MessageEvent('message', {
        data: { sequence, monotonicMs, wallMs, timeOrigin: 10000 },
      })
    );
  }
}
const recordings: ReturnType<typeof startRecordingHeartbeat>[] = [];
function start() {
  vi.stubGlobal('Worker', TestWorker);
  const result = startRecordingHeartbeat();
  recordings.push(result);
  return result;
}
function worker() {
  const result = TestWorker.instances.at(-1);
  if (!result) {
    throw new Error('Expected worker');
  }
  return result;
}
afterEach(() => {
  for (const result of recordings.splice(0)) {
    result.dispose();
  }
  TestWorker.instances.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('queued continuous sender ticks retain independent timing across a main-thread delivery gap', () => {
  let main = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => main);
  vi.spyOn(Date, 'now').mockImplementation(() => main + 10000);
  const result = start();
  worker().tick(1, 100);
  main = 5100;
  worker().tick(2, 200);
  worker().tick(3, 300);
  const evidence = result.read();
  expect(evidence.status).toBe('available');
  expect(evidence.ticks[1]).toMatchObject({
    senderGapMs: 100,
    receiverGapMs: 5000,
    sequenceGap: 1,
    clockJump: false,
  });
  expect(evidence.ticks[2]).toMatchObject({ senderGapMs: 100, receiverGapMs: 0 });
  expect(result.read().ticks).toEqual([]);
});

test('both-clock gaps, visibility changes and clock jumps remain raw evidence without a memory verdict', () => {
  let main = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => main);
  vi.spyOn(Date, 'now').mockImplementation(() => main + 10000);
  const result = start();
  worker().tick(1, 100);
  document.dispatchEvent(new Event('visibilitychange'));
  main = 5100;
  worker().tick(2, 5100);
  worker().tick(1, 20, 90000);
  const evidence = result.read();
  expect(evidence.ticks[1]).toMatchObject({
    senderGapMs: 5000,
    receiverGapMs: 5000,
    visibilityEpoch: 1,
  });
  expect(evidence.ticks[2]?.clockJump).toBe(true);
  expect(evidence.interpretation).toContain('gaps-in-both-are-ambiguous');
});

test('overfull evidence, worker failure, teardown and restart preserve missing-evidence boundaries', () => {
  const result = start();
  const first = worker();
  for (let index = 1; index <= 140; index++) {
    first.tick(index, index * 100);
  }
  const evidence = result.read();
  expect(evidence.ticks).toHaveLength(128);
  expect(evidence.observed).toBe(140);
  expect(evidence.omitted).toBe(12);
  first.onerror?.();
  expect(result.read().status).toBe('failed');
  expect(first.terminate).toHaveBeenCalledTimes(1);
  result.dispose();
  const restarted = start();
  expect(restarted.read().epoch).toBeGreaterThan(evidence.epoch);
  expect(restarted.read().status).toBe('starting');
  worker().onmessage?.(new MessageEvent('message', { data: { sequence: 'bad' } }));
  expect(restarted.read().status).toBe('failed');
});

test('unavailable workers report missing evidence and do not prevent recording', () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('Blocked');
      }
    }
  );
  const result = startRecordingHeartbeat();
  recordings.push(result);
  expect(result.read()).toMatchObject({ status: 'unavailable', ticks: [] });
});

test('the real worker timer emits increasing sender sequence and its own clocks', async () => {
  vi.useFakeTimers();
  const posted = vi.spyOn(globalThis, 'postMessage').mockImplementation(() => {});
  try {
    await import('../../../src/diagnostics/recordingHeartbeat.worker');
    await vi.advanceTimersByTimeAsync(300);
    expect(posted).toHaveBeenCalledTimes(3);
    const first: unknown = posted.mock.calls[0]?.[0];
    const third: unknown = posted.mock.calls[2]?.[0];
    expect(first).toMatchObject({
      sequence: 1,
      monotonicMs: expect.any(Number),
      wallMs: expect.any(Number),
      timeOrigin: performance.timeOrigin,
    });
    expect(third).toMatchObject({ sequence: 3 });
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
