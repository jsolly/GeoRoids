/* @vitest-environment node */
import { expect, test } from 'vitest';
import { FixtureCombatRecorder } from '../../../server/testing/FixtureCombatRecorder';

test('a saturated watched trajectory retains its terminal cause and counts missing segments', () => {
  const recorder = new FixtureCombatRecorder();
  recorder.start(['miner']);
  for (let frame = 0; frame < 1100; frame++) {
    recorder.record('miner', frame, {
      kind: 'segment',
      projectileId: 'shot',
      start: { x: frame, y: 0 },
      end: { x: frame + 1, y: 0 },
      candidates: null,
    });
  }
  recorder.record('miner', 1100, {
    kind: 'terminal',
    projectileId: 'shot',
    reason: 'asteroid',
    targetId: 'rock',
    position: { x: 1100, y: 0 },
    targetBefore: { health: 150 },
    targetAfter: { health: 125 },
  });
  const state = recorder.read();
  expect(state.dropped).toBe(76);
  expect(state.events).toHaveLength(1025);
  expect(state.events.at(-1)).toMatchObject({
    kind: 'terminal',
    reason: 'asteroid',
    targetId: 'rock',
  });
  recorder.record('unwatched', 1101, {
    kind: 'terminal',
    projectileId: 'other',
    reason: 'lifetime',
    targetId: null,
    position: { x: 0, y: 0 },
    targetBefore: null,
    targetAfter: null,
  });
  expect(recorder.read()).toEqual(state);
  recorder.start(['next-miner']);
  expect(recorder.read()).toEqual({ events: [], dropped: 0 });
});
