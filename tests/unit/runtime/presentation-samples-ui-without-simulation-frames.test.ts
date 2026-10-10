import { expect, it as test, vi } from 'vitest';
import { createPresentation } from '../../../src/runtime/presentation';

test('limits changing sampled HUD values to ten updates per second while delivering semantic changes immediately', () => {
  let score = 0;
  let overlay = 'none';
  const project = vi.fn(() => Object.freeze({ score, overlay }));
  const presentation = createPresentation(
    project,
    (previous, next) => previous.score === next.score && previous.overlay === next.overlay
  );
  const observed: { score: number; overlay: string }[] = [];
  const unsubscribe = presentation.subscribe((view) => observed.push(view));
  for (let frame = 0; frame < 60; frame++) {
    score++;
    presentation.sample((frame * 1000) / 60);
  }
  expect(observed).toHaveLength(11);
  expect(project).toHaveBeenCalledTimes(11);
  const last = observed.at(-1);
  overlay = 'schematic';
  presentation.transition();
  expect(observed.at(-1)?.overlay).toBe('schematic');
  expect(last?.overlay).toBe('none');
  presentation.transition();
  expect(observed).toHaveLength(12);
  unsubscribe();
  overlay = 'none';
  presentation.transition();
  expect(observed).toHaveLength(12);
  presentation.dispose();
  presentation.sample(2000);
  presentation.transition();
  const late = vi.fn();
  presentation.subscribe(late);
  expect(late).not.toHaveBeenCalled();
});
