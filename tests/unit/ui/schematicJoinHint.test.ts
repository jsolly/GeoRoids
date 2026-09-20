import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { STEERING } from '../../../src/constants';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';
import type { DrawingContext } from '../../../src/rendering/drawingContext';
import {
  drawSchematicJoinHint,
  initializeSchematicJoinHint,
  SCHEMATIC_JOIN_HINT_DURATION_MS,
  SCHEMATIC_JOIN_HINT_FADE_MS,
  SCHEMATIC_JOIN_HINT_GAP_ABOVE_CUE_PX,
  SCHEMATIC_JOIN_HINT_LINES,
  schematicJoinHintAlpha,
} from '../../../src/ui/schematicJoinHint';
import { setPlayView } from '../../../src/ui/uiUtils';
import * as viewportChrome from '../../../src/ui/viewportChrome';

const HAULER_RADIUS = hullRadiusForKit('hauler');
const OVERSIZED_HULL_RADIUS = STEERING.ARROW_DISTANCE_PX + 20;

function mockContext(): DrawingContext & { fillText: ReturnType<typeof vi.fn> } {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  } as unknown as DrawingContext & { fillText: ReturnType<typeof vi.fn> };
}

describe('touch join schematic hint', () => {
  beforeAll(() => {
    initializeSchematicJoinHint();
  });

  afterEach(() => {
    setPlayView(false);
    vi.restoreAllMocks();
  });

  test('a touch join paints the hold-to-equip lines above the hull, then fades', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    setPlayView(true);

    expect(schematicJoinHintAlpha(now)).toBe(1);
    const ctx = mockContext();
    drawSchematicJoinHint(ctx, 200, 300, HAULER_RADIUS, now);
    expect(ctx.fillText.mock.calls.map((call) => call[0])).toEqual([...SCHEMATIC_JOIN_HINT_LINES]);
    const lastLineY = Number(ctx.fillText.mock.calls.at(-1)?.[2]);
    expect(lastLineY).toBe(
      300 -
        Math.max(STEERING.ARROW_DISTANCE_PX, HAULER_RADIUS + 32) -
        SCHEMATIC_JOIN_HINT_GAP_ABOVE_CUE_PX
    );
    expect(lastLineY).toBeLessThan(300 - STEERING.ARROW_DISTANCE_PX);

    ctx.fillText.mockClear();
    drawSchematicJoinHint(ctx, 200, 300, OVERSIZED_HULL_RADIUS, now);
    expect(Number(ctx.fillText.mock.calls.at(-1)?.[2])).toBe(
      300 - (OVERSIZED_HULL_RADIUS + 32) - SCHEMATIC_JOIN_HINT_GAP_ABOVE_CUE_PX
    );

    now = 1_000 + SCHEMATIC_JOIN_HINT_DURATION_MS - SCHEMATIC_JOIN_HINT_FADE_MS / 2;
    expect(schematicJoinHintAlpha(now)).toBeCloseTo(0.5);
    now = 1_000 + SCHEMATIC_JOIN_HINT_DURATION_MS;
    expect(schematicJoinHintAlpha(now)).toBe(0);
    ctx.fillText.mockClear();
    drawSchematicJoinHint(ctx, 200, 300, HAULER_RADIUS, now);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  test('a desktop join keeps the playfield unlabeled', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(false);
    setPlayView(true);
    expect(schematicJoinHintAlpha()).toBe(0);
    const ctx = mockContext();
    drawSchematicJoinHint(ctx, 200, 300, 20);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  test('opening the schematic clears the join reminder', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    setPlayView(true);
    expect(schematicJoinHintAlpha()).toBe(1);
    window.dispatchEvent(new CustomEvent('gameSchematicOpen'));
    expect(schematicJoinHintAlpha()).toBe(0);
  });
});
