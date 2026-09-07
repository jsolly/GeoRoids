import { PALETTE } from '../../constants';
import { drawSoftFactionMark } from '../../entities/player/factionMarkPainters';
import type { Player } from '../../entities/player/Player';
import { getShipDisplayColor, hexToRgba } from '../../utils/colorUtils';
import { hudLayoutForCanvas } from './hudLayout';

interface LeaderboardEntry {
  name: string;
  score: number;
  type: 'local' | 'remote' | 'bot';
  factionId?: Player['factionId'];
  color?: string;
  isCurrentPlayer?: boolean;
}

const LEADERBOARD_FONT = '11px Arial';
const LEADERBOARD_RANK_X_OFFSET = 4;
const LEADERBOARD_FACTION_MARK_X_OFFSET = 20;
const LEADERBOARD_NAME_X_OFFSET = 28;
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

/** One row per name so a drop-then-rejoin clone does not list PilotB three times. */
export function uniquePlayersForLeaderboard<
  T extends { id: string; name: string; type: string; score: number },
>(players: readonly T[], currentPlayerId: string): T[] {
  const byName = new Map<string, T>();
  for (const player of players) {
    const current = byName.get(player.name);
    if (!current) {
      byName.set(player.name, player);
      continue;
    }
    const preferIncoming =
      player.id === currentPlayerId ||
      player.type === 'local' ||
      (current.id !== currentPlayerId && current.type !== 'local' && player.score >= current.score);
    if (preferIncoming) {
      byName.set(player.name, player);
    }
  }
  return [...byName.values()];
}

export function drawLeaderboard(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  players: Player[],
  currentPlayerId: string
): void {
  if (players.length === 0) {
    return;
  }

  const entries: LeaderboardEntry[] = uniquePlayersForLeaderboard(players, currentPlayerId)
    .map((player) => ({
      name: player.name,
      score: player.score,
      type: player.type,
      factionId: player.factionId,
      color: player.color,
      isCurrentPlayer: player.id === currentPlayerId,
    }))
    .sort((a, b) => b.score - a.score);

  const layout = hudLayoutForCanvas(canvas);
  const { x: boardX, y: boardY, width: boardWidth, rowHeight, maxRows } = layout.leaderboard;
  const visible = entries.slice(0, maxRows);

  ctx.save();

  visible.forEach((entry, index) => {
    const y = boardY + 6 + index * rowHeight;
    const nameColor = getShipDisplayColor(entry);
    const alpha = entry.isCurrentPlayer ? 0.92 : 0.78;

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

    // The fixed name anchor leaves the rank and faction mark on the left;
    // score measurement reserves the right column on compact boards.
    ctx.fillText(rankText, rankX, y);

    if (entry.factionId) {
      drawSoftFactionMark(ctx, entry.factionId, {
        x: boardX + LEADERBOARD_FACTION_MARK_X_OFFSET,
        y: y - 4,
        radius: 6,
        angle: Math.PI / 2,
        context: 'hud',
      });
    }

    ctx.fillStyle = hexToRgba(nameColor, alpha);
    ctx.fillText(fitLeaderboardName(ctx, entry.name, nameMaxWidth), nameX, y);

    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.55);
    ctx.textAlign = 'right';
    ctx.fillText(scoreText, scoreX, y);
  });

  ctx.restore();
}
