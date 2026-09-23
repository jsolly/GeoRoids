import {
  cargoCapacity,
  RESOURCES,
  settlementProgress,
  settlementRecipe,
} from '../../../shared/economy';
import { PALETTE, VISUAL } from '../../constants';
import { GameStateManager } from '../../core/services/GameStateManager';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { getShipKit } from '../../entities/ship/shipKits';
import { getSettlement } from '../../network/worldExploration';
import { hexToRgba } from '../../utils/colorUtils';
import type { PlayfieldSize } from '../playfieldCamera';
import { type HudLayout, scaleHudFont } from './hudLayout';

export function drawScoreOverlay(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  viewport: PlayfieldSize,
  score: number
): void {
  ctx.save();
  ctx.fillStyle = PALETTE.HUD;
  const viewportWidth = viewport.width;
  ctx.font = scaleHudFont(VISUAL.SCORE_FONT, layout.hudTypeScale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const origin = { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET + 10 };
  const dx = layout.balance.x - VISUAL.HUD_INSET;
  const dy = layout.balance.y - VISUAL.HUD_INSET;
  ctx.fillText(`Bank ${score.toLocaleString()}`, origin.x + dx, origin.y + dy);

  ctx.font = scaleHudFont(VISUAL.NAME_LABEL_FONT, layout.hudTypeScale);
  ctx.textBaseline = 'top';

  const localShip = PlayerManager.getInstance().getLocalShip();
  if (localShip) {
    const kit = getShipKit(localShip.kitId);
    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.85);
    ctx.fillText(kit.name, VISUAL.HUD_INSET + dx, layout.kitNameY);
  }

  const gameStateManager = GameStateManager.getInstance();
  if (gameStateManager.hasPickupMessage()) {
    ctx.fillStyle = PALETTE.SATELLITE;
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const pickupY = layout.notificationY;
    ctx.fillText(gameStateManager.getPickupMessage(), viewportWidth / 2, pickupY);
  }

  const pilot = PlayerManager.getInstance().getLocalPlayer();
  if (pilot) {
    const settlement = getSettlement();
    const recipe = settlementRecipe(settlement.level);
    const x = layout.balance.x;
    const y = layout.kitNameY + 20;
    const width = Math.min(340, viewportWidth - x - layout.padRight);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '12px Arial';
    ctx.fillStyle = PALETTE.HUD;
    ctx.fillText(
      `Cargo ${pilot.cargo}/${cargoCapacity(pilot.ship.kitId)} · Return to a furnace`,
      x,
      y
    );
    const progress = settlementProgress(settlement);
    ctx.fillText(
      `Settlement ${settlement.level} → ${settlement.level + 1} · ${Math.floor(progress * 100)}%`,
      x,
      y + 20
    );
    ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.18);
    ctx.fillRect(x, y + 37, width, 5);
    ctx.fillStyle = PALETTE.SATELLITE;
    ctx.fillRect(x, y + 37, width * progress, 5);
    ctx.fillStyle = PALETTE.HUD_MUTED;
    ctx.font = '10px Arial';
    ctx.fillText(`Points ${settlement.points}/${recipe.points}`, x, y + 47);
    ctx.fillText(
      RESOURCES.map((key) => `${key} ${settlement.resources[key]}/${recipe.resources[key]}`).join(
        ' · '
      ),
      x,
      y + 61,
      width
    );
  }
  ctx.restore();
}

function drawMultiLineText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  _alpha: number
): void {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine !== '') {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    const lineY = y + (i - (lines.length - 1) / 2) * lineHeight;
    ctx.fillText(line, x, lineY);
  }
}

export function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  viewport: PlayfieldSize,
  text: string,
  alpha: number
): void {
  ctx.save();

  const isDeathMessage = text.toLowerCase().includes('killed by');
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  const scale = layout.overlayFontScale;

  if (isDeathMessage) {
    ctx.fillStyle = hexToRgba(PALETTE.BG, alpha * 0.7);
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    ctx.fillStyle = hexToRgba(PALETTE.HUD, alpha);
    ctx.font = `bold ${Math.round(28 * scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxWidth = viewportWidth * 0.8;
    drawMultiLineText(ctx, text, centerX, centerY, maxWidth, 36 * scale, alpha);
  } else {
    ctx.fillStyle = hexToRgba(PALETTE.HUD, alpha);
    ctx.font = `${Math.round(32 * scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxWidth = viewportWidth * 0.8;
    drawMultiLineText(
      ctx,
      text,
      viewportWidth / 2,
      viewportHeight / 2,
      maxWidth,
      40 * scale,
      alpha
    );
  }

  ctx.restore();
}

export function drawDebugInfo(
  ctx: CanvasRenderingContext2D,
  viewport: PlayfieldSize,
  roidCount: number,
  debugMode: boolean
): void {
  if (!debugMode) {
    return;
  }

  ctx.save();
  ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.7);
  ctx.font = '12px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const canvasHeight = viewport.height;
  ctx.fillText(`debug  asteroids ${roidCount}`, 10, canvasHeight - 28);

  ctx.restore();
}
