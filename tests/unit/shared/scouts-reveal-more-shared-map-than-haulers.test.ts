import { expect, test } from 'vitest';
import {
  EMPTY_EXPLORATION,
  EXPLORATION_RANGE,
  ExplorationMap,
  explorationCellAt,
  isCellExplored,
} from '../../../shared/exploration';

test('Scout passive vision clears a wider persistent area than Hauler vision', () => {
  const scout = new ExplorationMap();
  const hauler = new ExplorationMap();
  scout.reveal({ x: 0, y: 0 }, EXPLORATION_RANGE.scout);
  hauler.reveal({ x: 0, y: 0 }, EXPLORATION_RANGE.hauler);
  const cell = explorationCellAt({ x: 450, y: 0 });
  if (cell === null) {
    throw new Error('Fixture lies outside arena');
  }
  expect(isCellExplored(scout.snapshot(), cell)).toBe(true);
  expect(isCellExplored(hauler.snapshot(), cell)).toBe(false);
  scout.reveal({ x: 1500, y: 0 }, EXPLORATION_RANGE.hauler);
  expect(isCellExplored(scout.snapshot(), cell)).toBe(true);
  scout.reset();
  expect(scout.snapshot()).toEqual(EMPTY_EXPLORATION);
});
