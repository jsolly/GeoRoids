import type { CDPSession, Page } from 'playwright';

type ScreenPoint = { x: number; y: number };
export type TouchPoint = ScreenPoint & { id: number };
type TouchEventType = 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd';

export async function centerOf(page: Page, selector: string): Promise<ScreenPoint> {
  const box = await page.locator(selector).boundingBox();
  if (!box) {
    throw new Error(`Missing touch target ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Return a CSS-pixel point inside the visible game canvas. */
export async function canvasPoint(
  page: Page,
  horizontalRatio: number,
  verticalRatio: number
): Promise<ScreenPoint> {
  if (
    !Number.isFinite(horizontalRatio) ||
    !Number.isFinite(verticalRatio) ||
    horizontalRatio < 0 ||
    horizontalRatio > 1 ||
    verticalRatio < 0 ||
    verticalRatio > 1
  ) {
    throw new RangeError('Canvas point ratios must be finite values between 0 and 1');
  }
  const box = await page.locator('#gameCanvas').boundingBox();
  if (!box) {
    throw new Error('Missing touch target #gameCanvas');
  }
  return {
    x: box.x + box.width * horizontalRatio,
    y: box.y + box.height * verticalRatio,
  };
}

/** Send real browser touch input through Chromium's input boundary. */
export async function dispatchTouch(
  session: CDPSession,
  type: TouchEventType,
  touchPoints: TouchPoint[]
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints,
    modifiers: 0,
  });
}

type TouchControlState = {
  position: { x: number; y: number };
  thrusting: boolean;
  canShoot: boolean;
  lastShotTime: number;
  lasers: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldActive: boolean;
  shieldTimer: number;
  shieldCooldown: number;
  shieldFlashTime: number;
};

export async function readTouchControlState(page: Page): Promise<TouchControlState> {
  return page.evaluate(() => {
    const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
    if (!ship) {
      throw new Error('Local ship unavailable');
    }
    return {
      position: { x: ship.position.x, y: ship.position.y },
      thrusting: ship.thrusting,
      canShoot: ship.canShoot,
      lastShotTime: ship.lastShotTime,
      lasers: ship.lasers.length,
      abilityCooldownFrames: ship.abilityCooldownFrames,
      abilityActiveFrames: ship.abilityActiveFrames,
      shieldActive: ship.shieldActive,
      shieldTimer: ship.shieldTimer,
      shieldCooldown: ship.shieldCooldown,
      shieldFlashTime: ship.shieldFlashTime,
    };
  });
}

type TouchControlBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type TouchControlLayout = {
  viewport: { width: number; height: number };
  overflow: boolean;
  canvas: TouchControlBox | null;
  ability: TouchControlBox | null;
  shield: TouchControlBox | null;
};

export async function readTouchControlLayout(page: Page): Promise<TouchControlLayout> {
  return page.evaluate(() => {
    const box = (element: Element | null): TouchControlBox | null => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    };
    const canvas = document.querySelector<HTMLCanvasElement>('#gameCanvas');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      canvas: box(canvas),
      ability: box(document.getElementById('touch-ability')),
      shield: box(document.getElementById('touch-shield')),
    };
  });
}
