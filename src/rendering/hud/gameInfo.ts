import { FACTION_LABELS, getSideColor } from '../../../shared/factions';
import type { FactionId } from '../../../shared-types';
import { PALETTE, VISUAL } from '../../constants';
import { GameStateManager } from '../../core/services/GameStateManager';
import { drawSoftFactionMark } from '../../entities/player/factionMarkPainters';
import { PlayerManager } from '../../entities/player/PlayerManager';
import { getShipKit } from '../../entities/ship/shipKits';
import { hexToRgba } from '../../utils/colorUtils';
import type { PlayfieldSize } from '../playfieldCamera';
import { layoutHudCluster } from './cluster';
import { drawFuelGauge } from './fuel';
import { hudLayoutForCanvas, scaleHudFont } from './hudLayout';

export function drawScoreOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: PlayfieldSize,
  score: number,
  lives: number,
  faction?: FactionId
): void {
  ctx.save();
  ctx.fillStyle = PALETTE.HUD;
  const layout = hudLayoutForCanvas(viewport);
  ctx.font = scaleHudFont(VISUAL.SCORE_FONT, layout.hudTypeScale);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const { score: origin } = layoutHudCluster(lives);
  const dx = layout.lives.x - VISUAL.HUD_INSET;
  const dy = layout.lives.y - VISUAL.HUD_INSET;
  ctx.fillText(score.toString(), origin.x + dx, origin.y + dy);

  ctx.font = scaleHudFont(VISUAL.NAME_LABEL_FONT, layout.hudTypeScale);
  ctx.textBaseline = 'top';
  if (faction) {
    ctx.fillStyle = hexToRgba(getSideColor(faction), 0.85);
    const metaX = VISUAL.HUD_INSET + dx;
    const factionLabel = FACTION_LABELS[faction];
    drawSoftFactionMark(ctx, faction, {
      x: metaX + 3,
      y: layout.factionY + 6,
      radius: 6,
      angle: Math.PI / 2,
      context: 'hud',
    });
    ctx.fillText(factionLabel, metaX + 11, layout.factionY);
  }

  const localShip = PlayerManager.getInstance().getLocalShip();
  if (localShip) {
    const kit = getShipKit(localShip.kitId);
    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.85);
    ctx.fillText(kit.name, VISUAL.HUD_INSET + dx, layout.kitNameY);
    drawFuelGauge(ctx, localShip.fuel, localShip.maxFuel, layout.fuel);
  }

  const gameStateManager = GameStateManager.getInstance();
  if (gameStateManager.hasKillMessage()) {
    ctx.fillStyle = PALETTE.DANGER;
    ctx.font = scaleHudFont('bold 14px Arial', layout.hudTypeScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(gameStateManager.getKillMessage(), viewport.width / 2, layout.killMessageY);
  }
  if (gameStateManager.hasPickupMessage()) {
    ctx.fillStyle = PALETTE.SATELLITE_PICKUP;
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const pickupY = gameStateManager.hasKillMessage()
      ? layout.killMessageY + 18
      : layout.killMessageY;
    ctx.fillText(gameStateManager.getPickupMessage(), viewport.width / 2, pickupY);
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
  viewport: PlayfieldSize,
  text: string,
  alpha: number
): void {
  ctx.save();

  const isDeathMessage = text.toLowerCase().includes('killed by');
  const isGameOver = text.toLowerCase().includes('game over');
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const scale = hudLayoutForCanvas(viewport).overlayFontScale;

  if (isGameOver) {
    ctx.fillStyle = hexToRgba(PALETTE.BG, alpha * 0.8);
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    ctx.fillStyle = hexToRgba(PALETTE.DANGER, alpha);
    ctx.font = `bold ${Math.round(48 * scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GAME OVER', centerX, centerY - 80 * scale);

    if (isDeathMessage) {
      const deathCause = text.replace(/^Game Over:\s*/i, '');
      ctx.fillStyle = hexToRgba(PALETTE.HUD, alpha);
      ctx.font = `${Math.round(24 * scale)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const maxWidth = viewport.width * 0.8;
      drawMultiLineText(
        ctx,
        deathCause,
        centerX,
        centerY + 20 * scale,
        maxWidth,
        32 * scale,
        alpha
      );
    }

    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, alpha * 0.8);
    ctx.font = `${Math.round(16 * scale)}px Arial`;
    ctx.fillText('Returning to main menu...', centerX, centerY + 120 * scale);
  } else if (isDeathMessage) {
    ctx.fillStyle = hexToRgba(PALETTE.BG, alpha * 0.7);
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    ctx.fillStyle = hexToRgba(PALETTE.HUD, alpha);
    ctx.font = `bold ${Math.round(28 * scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxWidth = viewport.width * 0.8;
    drawMultiLineText(ctx, text, centerX, centerY, maxWidth, 36 * scale, alpha);
  } else {
    ctx.fillStyle = hexToRgba(PALETTE.HUD, alpha);
    ctx.font = `${Math.round(32 * scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxWidth = viewport.width * 0.8;
    drawMultiLineText(
      ctx,
      text,
      viewport.width / 2,
      viewport.height / 2,
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
