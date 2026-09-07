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
    ctx.font = '11px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`${index + 1}.`, boardX + 4, y);

    if (entry.factionId) {
      drawSoftFactionMark(ctx, entry.factionId, {
        x: boardX + 20,
        y: y - 4,
        radius: 6,
        angle: Math.PI / 2,
        context: 'hud',
      });
    }

    ctx.fillStyle = hexToRgba(nameColor, alpha);
    ctx.fillText(entry.name, boardX + 28, y);

    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.55);
    ctx.textAlign = 'right';
    ctx.fillText(entry.score.toString(), boardX + boardWidth - 4, y);
  });

  ctx.restore();
}
