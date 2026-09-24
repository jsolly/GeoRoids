import { TOUCH, VISUAL } from '../../constants';
import { queryViewport, shouldUseTouchControls } from '../../ui/viewportChrome';
import type { PlayfieldSize } from '../playfieldCamera';

export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type HudLayout = {
  compact: boolean;
  padTop: number;
  padLeft: number;
  padRight: number;
  padBottom: number;
  balance: { x: number; y: number };
  score: { x: number; y: number };
  notificationY: number;
  leaderboard: {
    x: number;
    y: number;
    width: number;
    rowHeight: number;
    maxRows: number;
  };
  miniMap: { x: number; y: number; size: number };
  overlayFontScale: number;
  hudTypeScale: number;
  kitNameY: number;
  economyBottomY: number;
};

/** Scale a canvas font such as `14px Arial` for the compact touch HUD. */
export function scaleHudFont(font: string, scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
    return font;
  }
  return font.replace(
    HUD_FONT_SIZE_PATTERN,
    (_, px: string) => `${Math.max(1, Math.round(Number(px) * scale))}px`
  );
}

const HUD_FONT_SIZE_PATTERN = /(\d+(?:\.\d+)?)px/u;
const ZERO_SAFE: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DESKTOP_EDGE = VISUAL.HUD_INSET;

function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') {
    return { ...ZERO_SAFE };
  }
  const probe = document.querySelector('#safe-area-probe');
  if (!probe) {
    return { ...ZERO_SAFE };
  }
  const style = getComputedStyle(probe);
  return {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
}

export function computeHudLayout(
  viewport: PlayfieldSize,
  options?: {
    touchControls?: boolean;
    safeArea?: SafeAreaInsets;
  }
): HudLayout {
  const safe = options?.safeArea ?? ZERO_SAFE;
  const touch =
    options?.touchControls ??
    shouldUseTouchControls({
      ...queryViewport(),
      width: viewport.width,
      height: viewport.height,
    });

  const overlayFontScale = viewport.width < 480 ? 0.72 : viewport.width < 700 ? 0.85 : 1;
  const hudTypeScale = touch ? (viewport.width < 480 ? 1.18 : 1.1) : 1;

  if (!touch) {
    const balance = { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET };
    const kitNameY = balance.y + VISUAL.HUD_BALANCE_HEIGHT + 8;
    return {
      compact: false,
      padTop: 0,
      padLeft: 0,
      padRight: 0,
      padBottom: 0,
      balance,
      score: { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET },
      notificationY: 12,
      leaderboard: {
        x: viewport.width - 180 - DESKTOP_EDGE,
        y: DESKTOP_EDGE,
        width: 180,
        rowHeight: 16,
        maxRows: 10,
      },
      miniMap: {
        x: viewport.width - DESKTOP_EDGE - VISUAL.MINIMAP_SIZE,
        y: viewport.height - DESKTOP_EDGE - VISUAL.MINIMAP_SIZE,
        size: VISUAL.MINIMAP_SIZE,
      },
      overlayFontScale,
      hudTypeScale,
      kitNameY,
      economyBottomY: kitNameY + 96,
    };
  }

  const padLeft = Math.max(12, safe.left + 8);
  const padRight = Math.max(12, safe.right + 8);
  const padTop = Math.max(12, safe.top + 8);
  const padBottom = Math.max(12, safe.bottom + 8);
  const compactHeight = viewport.height < 500;
  const boardWidth = Math.min(168, Math.round(viewport.width * 0.3));
  const rowHeight = compactHeight ? 16 : 18;
  const maxRows = 3;
  const miniMapSize = compactHeight ? 64 : 80;
  const balance = { x: padLeft, y: padTop };
  const kitNameY = balance.y + 20;
  const clusterClear = kitNameY + Math.round(18 * hudTypeScale);
  const miniMap = compactHeight
    ? {
        x: viewport.width - padRight - miniMapSize,
        y: viewport.height - padBottom - miniMapSize,
        size: miniMapSize,
      }
    : {
        x: viewport.width - padRight - miniMapSize,
        y: viewport.height - padBottom - TOUCH.ACTION_RESERVE - miniMapSize,
        size: miniMapSize,
      };

  return {
    compact: true,
    padTop,
    padLeft,
    padRight,
    padBottom,
    balance,
    score: { x: padLeft, y: padTop },
    notificationY: Math.max(clusterClear, padTop + rowHeight * maxRows) + 64,
    leaderboard: {
      x: viewport.width - boardWidth - padRight,
      y: padTop,
      width: boardWidth,
      rowHeight,
      maxRows,
    },
    miniMap,
    overlayFontScale,
    hudTypeScale,
    kitNameY,
    economyBottomY: kitNameY + 18,
  };
}

export function hudLayoutForCanvas(viewport: PlayfieldSize): HudLayout {
  return computeHudLayout(viewport, { safeArea: readSafeAreaInsets() });
}
