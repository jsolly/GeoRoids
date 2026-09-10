import assert from 'node:assert/strict';

function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function number(value: unknown) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return value;
}

/** Recovery exclusions apply only to scheduled instants inside browser game-over recovery. */
export function inspectInputCadence(rawSchedule: unknown, rawRestarts: unknown) {
  assert(Array.isArray(rawSchedule) && Array.isArray(rawRestarts), 'Missing cadence ledger');
  const recoveries = rawRestarts.map(object).map((restart) => {
    assert(
      restart['kind'] === 'browser-gameover' || restart['kind'] === 'peer-rejoin',
      'Unknown recovery kind'
    );
    const start = number(restart['startedAt']);
    const duration = number(restart['durationMs']);
    assert(duration <= 10000, 'Recovery exceeded setup deadline');
    return { kind: restart['kind'], start, end: start + duration };
  });
  const schedule = rawSchedule.map(object).filter((slot) => slot['measured'] === true);
  assert(schedule.length >= 300, 'Missing 300 measured input slots');
  const lateness: number[] = [];
  let previous: { at: number; missed: number } | undefined;
  let recoverySkippedSlots = 0;
  for (const slot of schedule) {
    const at = number(slot['scheduledAt']);
    const started = number(slot['startedAt']);
    const missed = number(slot['missedSlots']);
    assert(Number.isInteger(missed), 'Invalid missed slot count');
    assert(started >= at - 1, 'Input slot started early');
    assert.equal(
      missed,
      Math.max(0, Math.floor((started - at) / 1000)),
      'Incorrect missed slot count'
    );
    if (previous) {
      assert(
        Math.abs(at - previous.at - (previous.missed + 1) * 1000) < 1,
        'Input slots are not anchored at 1 Hz'
      );
    }
    for (let index = 0; index < missed; index++) {
      const instant = at + index * 1000;
      assert(
        recoveries.some(
          (recovery) =>
            recovery.kind === 'browser-gameover' &&
            instant >= recovery.start &&
            instant < recovery.end
        ),
        'Missed active-play input slots invalidate controlled timing'
      );
      recoverySkippedSlots++;
    }
    lateness.push(Math.max(0, started - at));
    previous = { at, missed };
  }
  return { lateness, recoverySkippedSlots };
}
