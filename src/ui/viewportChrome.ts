import { TOUCH } from '../constants';

export type ViewportQuery = {
  width: number;
  height: number;
  maxTouchPoints: number;
  coarsePointer: boolean;
  hoverNone: boolean;
};

type WindowLike = {
  innerWidth: number;
  innerHeight: number;
  visualViewport?: { width: number; height: number } | null;
  navigator?: { maxTouchPoints?: number };
  matchMedia?: (query: string) => { matches: boolean };
};

function matchesMedia(win: WindowLike, query: string): boolean {
  if (typeof win.matchMedia !== 'function') {
    return false;
  }
  return win.matchMedia(query).matches;
}

export function queryViewport(win: WindowLike = window): ViewportQuery {
  const vv = win.visualViewport;
  return {
    width: Math.max(1, Math.round(vv?.width ?? win.innerWidth)),
    height: Math.max(1, Math.round(vv?.height ?? win.innerHeight)),
    maxTouchPoints: win.navigator?.maxTouchPoints ?? 0,
    coarsePointer: matchesMedia(win, '(pointer: coarse)'),
    hoverNone: matchesMedia(win, '(hover: none)'),
  };
}

/** Phone/tablet viewport or a coarse pointer — show the full touch control set. */
export function shouldUseTouchControls(query: ViewportQuery = queryViewport()): boolean {
  if (query.coarsePointer || query.hoverNone) {
    return true;
  }
  if (query.width <= TOUCH.PHONE_MAX_WIDTH) {
    return true;
  }
  if (
    query.height <= TOUCH.PHONE_LANDSCAPE_MAX_HEIGHT &&
    query.width <= TOUCH.PHONE_LANDSCAPE_MAX_WIDTH
  ) {
    return true;
  }
  return query.maxTouchPoints > 0 && Math.min(query.width, query.height) <= TOUCH.TABLET_MIN_SIDE;
}

export const DESKTOP_CONTROLS_HINT = 'WASD + Space · E ability · F shield';
export const TOUCH_CONTROLS_HINT = 'Hold screen to steer + thrust · Fire · Ability · Shield';

export function controlsHintFor(query: ViewportQuery = queryViewport()): string {
  return shouldUseTouchControls(query) ? TOUCH_CONTROLS_HINT : DESKTOP_CONTROLS_HINT;
}
