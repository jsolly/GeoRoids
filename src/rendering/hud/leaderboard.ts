import { PALETTE } from '../../constants';
import type { Player } from '../../entities/player/Player';
import { hexToRgba } from '../../utils/colorUtils';
import type { HudLayout } from './hudLayout';

const LEADERBOARD_FONT = '11px Arial';
const LEADERBOARD_RANK_X_OFFSET = 4;
const LEADERBOARD_NAME_X_OFFSET = 20;
const LEADERBOARD_SCORE_X_INSET = 4;
const LEADERBOARD_NAME_SCORE_GAP = 6;
const LEADERBOARD_ELLIPSIS = '…';

type TextMeasurer = Pick<CanvasRenderingContext2D, 'measureText'>;

/**
 * Keep the full name when it fits, otherwise use the longest measured prefix
 * that leaves room for an ellipsis. Array.from keeps surrogate pairs intact.
 */
export function fitLeaderboardName(ctx: TextMeasurer, name: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return '';
  }
  if (ctx.measureText(name).width <= maxWidth) {
    return name;
  }

  const ellipsisWidth = ctx.measureText(LEADERBOARD_ELLIPSIS).width;
  if (ellipsisWidth > maxWidth) {
    return '';
  }

  const characters = Array.from(name);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const candidatePrefix = characters.slice(0, count).join('').trimEnd();
    const candidate = `${candidatePrefix}${LEADERBOARD_ELLIPSIS}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      low = count;
    } else {
      high = count - 1;
    }
  }

  return `${characters.slice(0, low).join('').trimEnd()}${LEADERBOARD_ELLIPSIS}`;
}

export function drawLeaderboard(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  players: Player[],
  currentPlayerId: string
): void {
  if (players.length === 0) {
    return;
  }

  const entries = players.toSorted((a, b) => b.score - a.score);

  const { x: boardX, y: boardY, width: boardWidth, rowHeight, maxRows } = layout.leaderboard;
  const visible = entries.slice(0, maxRows);

  ctx.save();

  visible.forEach((entry, index) => {
    const y = boardY + 6 + index * rowHeight;
    const nameColor = entry.color;
    const alpha = entry.id === currentPlayerId ? 0.92 : 0.78;

    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.4);
    ctx.font = LEADERBOARD_FONT;
    ctx.textAlign = 'left';
    const rankText = `${index + 1}.`;
    const rankX = boardX + LEADERBOARD_RANK_X_OFFSET;
    const nameX = boardX + LEADERBOARD_NAME_X_OFFSET;
    const scoreText = entry.score.toString();
    const scoreX = boardX + boardWidth - LEADERBOARD_SCORE_X_INSET;
    const scoreWidth = ctx.measureText(scoreText).width;
    const nameMaxWidth = Math.max(0, scoreX - scoreWidth - LEADERBOARD_NAME_SCORE_GAP - nameX);

    // Score measurement reserves the right column on compact boards.
    ctx.fillText(rankText, rankX, y);

    ctx.fillStyle = hexToRgba(nameColor, alpha);
    const suffix = entry.type === 'bot' ? ' (bot)' : '';
    const fittedName = fitLeaderboardName(
      ctx,
      entry.name,
      Math.max(0, nameMaxWidth - ctx.measureText(suffix).width)
    );
    ctx.fillText(fittedName + suffix, nameX, y);

    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.55);
    ctx.textAlign = 'right';
    ctx.fillText(scoreText, scoreX, y);
  });

  ctx.restore();
}
