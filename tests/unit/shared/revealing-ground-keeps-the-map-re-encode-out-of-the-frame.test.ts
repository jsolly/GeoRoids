import { expect, test, vi } from 'vitest';
import { ExplorationMap, isCellExplored, validExploration } from '../../../shared/exploration';

/**
 * `reveal` runs inside the 60 Hz tick, once per exploring pilot. Re-encoding the
 * whole tile map there is O(explored world) and grows for the life of the save, so
 * the encode belongs to the readers instead. `Array.from` appears exactly once in
 * `shared/exploration.ts` — the encode itself — so counting it counts re-encodes.
 */
test('revealing ground defers the exploration re-encode to the next reader', () => {
  const map = new ExplorationMap();
  const encodes = vi.spyOn(Array, 'from');
  try {
    // Five separate revealing steps, each moving far enough to light new cells.
    const revealed: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      const changed = map.reveal({ x: step * 400, y: 0 }, 300);
      expect(changed.length).toBeGreaterThan(0);
      revealed.push(...changed);
    }
    expect(encodes).not.toHaveBeenCalled();

    // The first reader pays for one encode covering all five steps.
    const tiles = map.snapshot();
    expect(encodes).toHaveBeenCalledTimes(1);
    expect(validExploration(tiles)).toBe(true);
    expect(tiles.length).toBeGreaterThan(0);

    // Reading again reuses it; membership and identity both hold.
    expect(map.snapshot()).toBe(tiles);
    expect(encodes).toHaveBeenCalledTimes(1);

    // Independent oracle: every cell reveal reported must read back as explored
    // through the public reader, and ground nobody flew over must not.
    for (const cell of revealed) {
      expect(isCellExplored(tiles, cell)).toBe(true);
    }
    const untouched = map.reveal({ x: 0, y: 40_000 }, 300);
    expect(untouched.length).toBeGreaterThan(0);
    expect(isCellExplored(tiles, untouched[0] ?? -1)).toBe(false);

    // That reveal changed cells, so the next read re-encodes exactly once more.
    const grown = map.snapshot();
    expect(encodes).toHaveBeenCalledTimes(2);
    expect(grown).not.toBe(tiles);
    expect(isCellExplored(grown, untouched[0] ?? -1)).toBe(true);

    // Re-revealing already-lit ground reports no change and invalidates nothing.
    expect(map.reveal({ x: 0, y: 40_000 }, 1)).toEqual([]);
    expect(map.snapshot()).toBe(grown);
    expect(encodes).toHaveBeenCalledTimes(2);

    // restore and reset both leave a clean cache rather than a stale pending encode.
    map.restore(grown);
    expect(map.snapshot()).toBe(map.snapshot());
    const afterRestore = encodes.mock.calls.length;
    expect(map.snapshot()).toEqual(grown);
    expect(encodes).toHaveBeenCalledTimes(afterRestore);

    map.reset();
    expect(map.snapshot()).toEqual([]);
    expect(encodes).toHaveBeenCalledTimes(afterRestore);
  } finally {
    vi.restoreAllMocks();
  }
});
