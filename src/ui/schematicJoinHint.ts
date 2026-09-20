import { PALETTE } from '../constants';
import type { DrawingContext } from '../rendering/drawingContext';
import { headingCueTipDistance } from '../rendering/headingCueRenderer';
import { hexToRgba } from '../utils/colorUtils';
import { shouldUseTouchControls } from './viewportChrome';

export const SCHEMATIC_JOIN_HINT_LINES = ['Tap and hold your ship', 'to equip tools'] as const;
export const SCHEMATIC_JOIN_HINT_DURATION_MS = 4800;
export const SCHEMATIC_JOIN_HINT_FADE_MS = 800;
export const SCHEMATIC_JOIN_HINT_GAP_ABOVE_CUE_PX = 12;

const HINT_FONT = '13px Arial';
const HINT_LINE_HEIGHT = 16;
const HINT_ALPHA = 0.92;

let initialized = false;
let startedAt: number | null = null;
let dismissed = false;

function startHint(now: number): void {
  dismissed = false;
  startedAt = shouldUseTouchControls() ? now : null;
}

function clearHint(): void {
  startedAt = null;
  dismissed = false;
}

export function initializeSchematicJoinHint(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }
  initialized = true;
  window.addEventListener('playViewOn', () => {
    startHint(performance.now());
  });
  window.addEventListener('playViewOff', clearHint);
  window.addEventListener('gameSchematicOpen', () => {
    dismissed = true;
    startedAt = null;
  });
  if (document.body.classList.contains('in-play')) {
    startHint(performance.now());
  }
}

export function schematicJoinHintAlpha(now = performance.now()): number {
  if (dismissed || startedAt === null || !shouldUseTouchControls()) {
    return 0;
  }
  const elapsed = now - startedAt;
  if (elapsed < 0 || elapsed >= SCHEMATIC_JOIN_HINT_DURATION_MS) {
    return 0;
  }
  const remaining = SCHEMATIC_JOIN_HINT_DURATION_MS - elapsed;
  if (remaining >= SCHEMATIC_JOIN_HINT_FADE_MS) {
    return 1;
  }
  return remaining / SCHEMATIC_JOIN_HINT_FADE_MS;
}

export function drawSchematicJoinHint(
  ctx: DrawingContext,
  screenX: number,
  screenY: number,
  shipR: number,
  now = performance.now()
): void {
  const alpha = schematicJoinHintAlpha(now);
  if (alpha <= 0) {
    return;
  }
  const lastLineY = screenY - headingCueTipDistance(shipR) - SCHEMATIC_JOIN_HINT_GAP_ABOVE_CUE_PX;
  const firstLineY = lastLineY - (SCHEMATIC_JOIN_HINT_LINES.length - 1) * HINT_LINE_HEIGHT;
  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.HUD, HINT_ALPHA * alpha);
  ctx.font = HINT_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const [index, line] of SCHEMATIC_JOIN_HINT_LINES.entries()) {
    ctx.fillText(line, screenX, firstLineY + index * HINT_LINE_HEIGHT);
  }
  ctx.restore();
}
