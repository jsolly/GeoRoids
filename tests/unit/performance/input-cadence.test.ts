import { expect, test } from 'vitest';
import { inspectInputCadence } from '../../../benchmarks/input-cadence';

function schedule() {
  return Array.from({ length: 300 }, (_, index) => ({
    measured: true,
    scheduledAt: (index + (index > 10 ? 3 : 0)) * 1000,
    startedAt: (index + (index >= 10 ? 3 : 0)) * 1000 + 1,
    missedSlots: index === 10 ? 3 : 0,
  }));
}
const recovery = { kind: 'browser-gameover', startedAt: 9900, durationMs: 3100 };
test('planned game-over recovery retains skipped slots without rejecting active-play cadence', () => {
  expect(inspectInputCadence(schedule(), [recovery]).recoverySkippedSlots).toBe(3);
});
test('unexplained delays and peer setup cannot excuse missed active-play inputs', () => {
  for (const restarts of [
    [],
    [{ ...recovery, kind: 'peer-rejoin' }],
    [{ ...recovery, durationMs: 1000 }],
    [{ ...recovery, startedAt: 10001 }],
  ]) {
    expect(() => inspectInputCadence(schedule(), restarts)).toThrow(/Missed active-play/);
  }
});
test('cadence evidence rejects invented slot counts, shifted clocks and incomplete runs', () => {
  const slots = schedule();
  const missed = slots[10];
  if (!missed) {
    throw new Error('Missing fixture slot');
  }
  missed.missedSlots = 0;
  expect(() => inspectInputCadence(slots, [recovery])).toThrow(/Incorrect missed/);
  expect(() => inspectInputCadence(schedule().slice(1), [recovery])).toThrow(/300/);
  const shifted = schedule();
  const offset = shifted[20];
  if (!offset) {
    throw new Error('Missing fixture slot');
  }
  offset.scheduledAt += 100;
  offset.startedAt += 100;
  expect(() => inspectInputCadence(shifted, [recovery])).toThrow(/anchored/);
});
