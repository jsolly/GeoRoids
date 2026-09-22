import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { STEERING } from '../../../src/constants';
import { hullRadiusForKit } from '../../../src/entities/ship/shipKits';
import type { DrawingContext } from '../../../src/rendering/drawingContext';
import {
  DESKTOP_SCHEMATIC_EQUIP_HINT_LINES,
  drawSchematicEquipHint,
  initializeSchematicEquipHint,
  SCHEMATIC_EQUIP_HINT_DURATION_MS,
  SCHEMATIC_EQUIP_HINT_FADE_MS,
  SCHEMATIC_EQUIP_HINT_GAP_ABOVE_CUE_PX,
  schematicEquipHintAlpha,
  showSchematicEquipHint,
  TOUCH_SCHEMATIC_EQUIP_HINT_LINES,
} from '../../../src/ui/schematicEquipHint';
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

describe('equip reminder after a pickup', () => {
  beforeAll(() => {
    initializeSchematicEquipHint();
  });

  afterEach(() => {
    setPlayView(false);
    vi.restoreAllMocks();
  });

  test('a touch flight stays unlabeled until a pickup, then paints the hold-to-equip lines and fades', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    setPlayView(true);

    expect(schematicEquipHintAlpha(now)).toBe(0);
    const ctx = mockContext();
    drawSchematicEquipHint(ctx, 200, 300, HAULER_RADIUS, now);
    expect(ctx.fillText).not.toHaveBeenCalled();

    showSchematicEquipHint();
    expect(schematicEquipHintAlpha(now)).toBe(1);
    drawSchematicEquipHint(ctx, 200, 300, HAULER_RADIUS, now);
    expect(ctx.fillText.mock.calls.map((call) => call[0])).toEqual([
      ...TOUCH_SCHEMATIC_EQUIP_HINT_LINES,
    ]);
    const lastLineY = Number(ctx.fillText.mock.calls.at(-1)?.[2]);
    expect(lastLineY).toBe(
      300 -
        Math.max(STEERING.ARROW_DISTANCE_PX, HAULER_RADIUS + 32) -
        SCHEMATIC_EQUIP_HINT_GAP_ABOVE_CUE_PX
    );
    expect(lastLineY).toBeLessThan(300 - STEERING.ARROW_DISTANCE_PX);

    ctx.fillText.mockClear();
    drawSchematicEquipHint(ctx, 200, 300, OVERSIZED_HULL_RADIUS, now);
    expect(Number(ctx.fillText.mock.calls.at(-1)?.[2])).toBe(
      300 - (OVERSIZED_HULL_RADIUS + 32) - SCHEMATIC_EQUIP_HINT_GAP_ABOVE_CUE_PX
    );

    now = 1_000 + SCHEMATIC_EQUIP_HINT_DURATION_MS - SCHEMATIC_EQUIP_HINT_FADE_MS / 2;
    expect(schematicEquipHintAlpha(now)).toBeCloseTo(0.5);
    now = 1_000 + SCHEMATIC_EQUIP_HINT_DURATION_MS;
    expect(schematicEquipHintAlpha(now)).toBe(0);
    ctx.fillText.mockClear();
    drawSchematicEquipHint(ctx, 200, 300, HAULER_RADIUS, now);
    expect(ctx.fillText).not.toHaveBeenCalled();

    showSchematicEquipHint();
    now += 10;
    expect(schematicEquipHintAlpha(now)).toBe(1);
  });

  test('a desktop pickup says to press V, and joining alone stays unlabeled', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(false);
    setPlayView(true);
    expect(schematicEquipHintAlpha()).toBe(0);
    const ctx = mockContext();
    drawSchematicEquipHint(ctx, 200, 300, 20);
    expect(ctx.fillText).not.toHaveBeenCalled();

    showSchematicEquipHint();
    expect(schematicEquipHintAlpha()).toBe(1);
    drawSchematicEquipHint(ctx, 200, 300, 20);
    expect(ctx.fillText.mock.calls.map((call) => call[0])).toEqual([
      ...DESKTOP_SCHEMATIC_EQUIP_HINT_LINES,
    ]);
  });

  test('a pickup before flight does not arm the reminder', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    showSchematicEquipHint();
    setPlayView(true);
    expect(schematicEquipHintAlpha()).toBe(0);
  });

  test('leaving the flight clears the reminder', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    setPlayView(true);
    showSchematicEquipHint();
    expect(schematicEquipHintAlpha()).toBe(1);
    setPlayView(false);
    expect(schematicEquipHintAlpha()).toBe(0);
    setPlayView(true);
    expect(schematicEquipHintAlpha()).toBe(0);
  });

  test('opening the schematic clears the pickup reminder', () => {
    vi.spyOn(viewportChrome, 'shouldUseTouchControls').mockReturnValue(true);
    setPlayView(true);
    showSchematicEquipHint();
    expect(schematicEquipHintAlpha()).toBe(1);
    window.dispatchEvent(new CustomEvent('gameSchematicOpen'));
    expect(schematicEquipHintAlpha()).toBe(0);
  });
});
