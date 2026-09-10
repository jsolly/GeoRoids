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
  padTop: number;
  padLeft: number;
  padRight: number;
  padBottom: number;
  lives: { x: number; y: number };
  score: { x: number; y: number };
  killMessageY: number;
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
  factionY: number;
  kitNameY: number;
  fuel: { x: number; y: number; width: number; height: number };
};

/** Scale a canvas font such as `14px Arial` for the compact touch HUD. */
export function scaleHudFont(font: string, scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
    return font;
  }
  return font.replace(
    /(\d+(?:\.\d+)?)px/,
    (_, px: string) => `${Math.max(1, Math.round(Number(px) * scale))}px`
  );
}

const ZERO_SAFE: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DESKTOP_EDGE = VISUAL.HUD_INSET;

function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') {
    return { ...ZERO_SAFE };
  }
  const probe = document.getElementById('safe-area-probe');
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
    const lives = { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET };
    const factionY = lives.y + VISUAL.HUD_LIFE_SIZE + 8;
    return {
      padTop: 0,
      padLeft: 0,
      padRight: 0,
      padBottom: 0,
      lives,
      score: { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET },
      killMessageY: 12,
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
      factionY,
      kitNameY: factionY + 14,
      fuel: {
        x: lives.x,
        y: factionY + 32,
        width: VISUAL.FUEL_BAR_WIDTH,
        height: VISUAL.FUEL_BAR_HEIGHT,
      },
    };
  }

  const padLeft = Math.max(12, safe.left + 8);
  const padRight = Math.max(12, safe.right + 8);
  const padTop = Math.max(12, safe.top + 8);
  const padBottom = Math.max(12, safe.bottom + 8);
  const compactHeight = viewport.height < 500;
  const boardWidth = viewport.width < 400 ? 148 : 168;
  const miniMapSize = compactHeight ? 64 : 80;
  const lives = { x: padLeft, y: padTop };
  const factionY = lives.y + VISUAL.HUD_LIFE_SIZE + 8;
  const kitNameY = factionY + Math.round(14 * hudTypeScale);
  const fuel = {
    x: lives.x,
    y: factionY + Math.round(32 * hudTypeScale),
    width: Math.round(VISUAL.FUEL_BAR_WIDTH * Math.max(1, hudTypeScale)),
    height: 3,
  };

  // Compact cluster + faction + kit + fuel sit under lives; park radar below that stack.
  const clusterClear = fuel.y + 16;
  const miniMap = compactHeight
    ? {
        x: padLeft,
        y: Math.max(padTop + VISUAL.HUD_LIFE_SIZE + 52, clusterClear),
        size: miniMapSize,
      }
    : {
        x: viewport.width - padRight - miniMapSize,
        y: viewport.height - padBottom - TOUCH.FIRE_RESERVE - miniMapSize,
        size: miniMapSize,
      };

  return {
    padTop,
    padLeft,
    padRight,
    padBottom,
    lives,
    score: { x: padLeft, y: padTop },
    killMessageY: padTop,
    leaderboard: {
      x: viewport.width - boardWidth - padRight,
      y: padTop,
      width: boardWidth,
      rowHeight: compactHeight ? 16 : 18,
      maxRows: compactHeight ? 4 : 6,
    },
    miniMap,
    overlayFontScale,
    hudTypeScale,
    factionY,
    kitNameY,
    fuel,
  };
}

export function hudLayoutForCanvas(viewport: PlayfieldSize): HudLayout {
  return computeHudLayout(viewport, { safeArea: readSafeAreaInsets() });
}
