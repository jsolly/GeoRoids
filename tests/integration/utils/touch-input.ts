import type { CDPSession, Page } from 'playwright';

export type TouchPoint = { x: number; y: number; id: number };
export type TouchEventType = 'touchStart' | 'touchMove' | 'touchCancel' | 'touchEnd';

export async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (!box) {
    throw new Error(`Missing touch target ${selector}`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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

export type TouchControlState = {
  position: { x: number; y: number };
  thrusting: boolean;
  canShoot: boolean;
  lastShotTime: number;
  lasers: number;
  abilityCooldownFrames: number;
  abilityActiveFrames: number;
  shieldActive: boolean;
  shieldCooldown: number;
};

export async function readTouchControlState(page: Page): Promise<TouchControlState> {
  return page.evaluate(() => {
    const ship = window.gameController?.getCurrPlayer()?.ship;
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
      shieldCooldown: ship.shieldCooldown,
    };
  });
}

export type TouchControlBox = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type TouchControlLayout = {
  viewport: { width: number; height: number };
  overflow: boolean;
  canvas: { width: number; height: number } | null;
  stick: TouchControlBox | null;
  fire: TouchControlBox | null;
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
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      stick: box(document.getElementById('touch-stick')),
      fire: box(document.getElementById('touch-fire')),
      ability: box(document.getElementById('touch-ability')),
      shield: box(document.getElementById('touch-shield')),
    };
  });
}
