import { PALETTE, VISUAL } from '../../constants';
import { DEFAULT_SHIP_KIT_ID, type ShipKitId } from '../../entities/ship/shipKits';
import { strokeKitHullOutline } from '../../entities/ship/shipRenderer';

import { layoutHudCluster } from './cluster';
import type { HudLayout } from './hudLayout';

export function drawLivesIndicator(
  ctx: CanvasRenderingContext2D,
  layout: HudLayout,
  lives: number,
  shipColor: string,
  kitId: ShipKitId = DEFAULT_SHIP_KIT_ID
): void {
  const { lifeCenters } = layoutHudCluster(lives);
  const dx = layout.lives.x - VISUAL.HUD_INSET;
  const dy = layout.lives.y - VISUAL.HUD_INSET;
  const radius = VISUAL.HUD_LIFE_SIZE / 2;
  const color = shipColor || PALETTE.LOCAL;

  ctx.save();
  for (const center of lifeCenters) {
    strokeKitHullOutline(
      ctx,
      center.x + dx,
      center.y + dy,
      radius,
      VISUAL.HUD_LIFE_HEADING,
      color,
      kitId
    );
  }
  ctx.restore();
}
