import { WIRE_PALETTE } from '../../../shared/constants/gameplay';
import {
  cargoCapacity,
  RESOURCES,
  settlementProgress,
  settlementRecipe,
} from '../../../shared/economy';
import { getShipKit } from '../../../shared/shipKits';
import { PALETTE, VISUAL } from '../../constants';
import { GameStateManager } from '../../core/services/GameStateManager';
import type { Player } from '../../entities/player/Player';
import { getSettlement } from '../../network/worldExploration';
import { hexToRgba } from '../../utils/colorUtils';
import { formatPoints } from '../../utils/formatPoints';
import type { PlayfieldSize } from '../playfieldCamera';
import type { HudLayout } from './hudLayout';

export function drawScoreOverlay(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  viewport: PlayfieldSize,
  pilot: Player
): void {
  ctx.save();
  ctx.fillStyle = PALETTE.HUD;
  const viewportWidth = viewport.width;
  ctx.font = VISUAL.SCORE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const { x, y } = layout.balance;
  const score = pilot.score;
  const compactWidth = layout.leaderboard.x - layout.balance.x - 12;
  if (layout.compact) {
    ctx.font = 'bold 12px Arial';
    ctx.fillText(
      `Bank ${formatPoints(score)} · Cargo ${pilot.cargo}/${cargoCapacity(pilot.ship.kitId)}`,
      x,
      y + 10,
      compactWidth
    );
  } else {
    ctx.fillText(`Bank ${formatPoints(score)}`, x, y + 10);
  }

  ctx.font = VISUAL.NAME_LABEL_FONT;
  ctx.textBaseline = 'top';

  const localShip = pilot.ship;
  if (localShip) {
    const kit = getShipKit(localShip.kitId);
    ctx.fillStyle = hexToRgba(PALETTE.HUD_MUTED, 0.85);
    if (layout.compact) {
      const settlement = getSettlement();
      ctx.font = '12px Arial';
      ctx.fillText(
        `${kit.name} · Settlement ${settlement.level} → ${settlement.level + 1} · ${Math.floor(settlementProgress(settlement) * 100)}%`,
        x,
        layout.kitNameY,
        compactWidth
      );
    } else {
      ctx.fillText(kit.name, x, layout.kitNameY);
    }
  }

  const gameStateManager = GameStateManager.getInstance();
  if (gameStateManager.hasPickupMessage()) {
    ctx.fillStyle = WIRE_PALETTE.SATELLITE;
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const pickupY = layout.notificationY;
    ctx.fillText(gameStateManager.getPickupMessage(), viewportWidth / 2, pickupY);
  }

  if (!layout.compact) {
    const settlement = getSettlement();
    const recipe = settlementRecipe(settlement.level);
    const settlementY = layout.kitNameY + 20;
    const width = Math.min(340, viewportWidth - x - layout.padRight);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '12px Arial';
    ctx.fillStyle = PALETTE.HUD;
    ctx.fillText(
      `Cargo ${pilot.cargo}/${cargoCapacity(pilot.ship.kitId)} · Return to a furnace`,
      x,
      settlementY
    );
    const progress = settlementProgress(settlement);
    ctx.fillText(
      `Settlement ${settlement.level} → ${settlement.level + 1} · ${Math.floor(progress * 100)}%`,
      x,
      settlementY + 20
    );
    ctx.fillStyle = hexToRgba(PALETTE.HUD, 0.18);
    ctx.fillRect(x, settlementY + 37, width, 5);
    ctx.fillStyle = WIRE_PALETTE.SATELLITE;
    ctx.fillRect(x, settlementY + 37, width * progress, 5);
    ctx.fillStyle = PALETTE.HUD_MUTED;
    ctx.font = '10px Arial';
    ctx.fillText(`Points ${settlement.points}/${recipe.points}`, x, settlementY + 47);
    ctx.fillText(
      RESOURCES.map((key) => `${key} ${settlement.resources[key]}/${recipe.resources[key]}`).join(
        ' · '
      ),
      x,
      settlementY + 61,
      width
    );
  }
  ctx.restore();
}
