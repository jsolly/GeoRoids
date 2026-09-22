import { PALETTE } from '../constants';
import type { DrawingContext } from '../rendering/drawingContext';
import { headingCueTipDistance } from '../rendering/headingCueRenderer';
import { hexToRgba } from '../utils/colorUtils';
import { shouldUseTouchControls } from './viewportChrome';

export const TOUCH_SCHEMATIC_EQUIP_HINT_LINES = [
  'Equipment is in your inventory',
  'Tap Inventory to equip',
] as const;
export const DESKTOP_SCHEMATIC_EQUIP_HINT_LINES = [
  'Equipment is in your inventory',
  'Press V to equip',
] as const;
export const SCHEMATIC_EQUIP_HINT_DURATION_MS = 4800;
export const SCHEMATIC_EQUIP_HINT_FADE_MS = 800;
export const SCHEMATIC_EQUIP_HINT_GAP_ABOVE_CUE_PX = 12;

const HINT_FONT = '13px Arial';
const HINT_LINE_HEIGHT = 16;
const HINT_ALPHA = 0.92;

let initialized = false;
let startedAt: number | null = null;
let pending = false;
let dismissed = false;

function inPlay(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains('in-play');
}

function clearHint(): void {
  startedAt = null;
  pending = false;
  dismissed = false;
}

export function showSchematicEquipHint(): void {
  if (!inPlay()) {
    return;
  }
  dismissed = false;
  startedAt = null;
  pending = true;
}

export function initializeSchematicEquipHint(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }
  initialized = true;
  window.addEventListener('playViewOff', clearHint);
  window.addEventListener('gameSchematicOpen', () => {
    dismissed = true;
    startedAt = null;
    pending = false;
  });
}

function schematicEquipHintLines(): readonly [string, string] {
  return shouldUseTouchControls()
    ? TOUCH_SCHEMATIC_EQUIP_HINT_LINES
    : DESKTOP_SCHEMATIC_EQUIP_HINT_LINES;
}

export function schematicEquipHintAlpha(now = performance.now()): number {
  if (dismissed || !inPlay()) {
    return 0;
  }
  if (startedAt === null) {
    if (!pending) {
      return 0;
    }
    startedAt = now;
    pending = false;
  }
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed >= SCHEMATIC_EQUIP_HINT_DURATION_MS) {
    return 0;
  }
  const remaining = SCHEMATIC_EQUIP_HINT_DURATION_MS - elapsed;
  if (remaining >= SCHEMATIC_EQUIP_HINT_FADE_MS) {
    return 1;
  }
  return remaining / SCHEMATIC_EQUIP_HINT_FADE_MS;
}

export function drawSchematicEquipHint(
  ctx: DrawingContext,
  screenX: number,
  screenY: number,
  shipR: number,
  now = performance.now()
): void {
  const alpha = schematicEquipHintAlpha(now);
  if (alpha <= 0) {
    return;
  }
  const lines = schematicEquipHintLines();
  const lastLineY = screenY - headingCueTipDistance(shipR) - SCHEMATIC_EQUIP_HINT_GAP_ABOVE_CUE_PX;
  const firstLineY = lastLineY - (lines.length - 1) * HINT_LINE_HEIGHT;
  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.HUD, HINT_ALPHA * alpha);
  ctx.font = HINT_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, screenX, firstLineY + index * HINT_LINE_HEIGHT);
  }
  ctx.restore();
}
