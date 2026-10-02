import type { Position } from '../../shared-types';
import { PALETTE, VISUAL } from '../constants';
import { hexToRgba } from '../utils/colorUtils';
import { type PlayfieldSize, projectWorldToScreenInto } from './playfieldCamera';

export type StarPoint = { x: number; y: number; alpha: number };
const starScreen = { x: 0, y: 0 };

/** The original native rectangle painter, shared by Canvas and GPU rear-source preparation. */
export function drawStarLayers(
  ctx: CanvasRenderingContext2D,
  tiles: readonly (readonly StarPoint[])[],
  shipPosition: Position,
  viewport: PlayfieldSize,
  scale: number,
  rotation: number
): { nativeStars: number; nativeStarRects: number } {
  const size = VISUAL.STAR_SIZE;
  const screen = starScreen;
  let nativeStars = 0;
  let nativeStarRects = 0;
  for (const tile of tiles) {
    for (const star of tile) {
      nativeStars++;
      projectWorldToScreenInto(screen, star, shipPosition, viewport, scale, rotation);
      const sx = screen.x;
      const sy = screen.y;
      if (sx < -size || sy < -size || sx > viewport.width + size || sy > viewport.height + size) {
        continue;
      }
      ctx.fillStyle =
        'fillStyle' in star && typeof star.fillStyle === 'string'
          ? star.fillStyle
          : hexToRgba(PALETTE.STARS, star.alpha);
      ctx.fillRect((sx + 0.5) | 0, (sy + 0.5) | 0, size, size);
      nativeStarRects++;
    }
  }
  return { nativeStars, nativeStarRects };
}
