import { PLAYFIELD_CLOSE_SCALE } from '../../../src/rendering/playfieldCamera';

type WorldPoint = { x: number; y: number };
type EnhancedTarget = {
  id: string;
  position: WorldPoint;
  size: number;
  material?: string;
  phenomenon?: { kind: string; clusterId?: string; energy?: number; maxEnergy?: number };
};

export function captureConsole(page: import('playwright').Page): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
    if (message.type() === 'warning') {
      warnings.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { errors, warnings };
}

export async function waitForEnhancedTargets(page: import('playwright').Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const controller = window.gameController;
      if (!controller) {
        return false;
      }
      const state = controller.getAsteroidToolsController().getState();
      return Boolean(state.pilot?.alive && state.targets.length > 0);
    },
    undefined,
    { timeout: 20_000, polling: 100 }
  );
}

export function safestReflectiveCluster(
  targets: EnhancedTarget[],
  hazards: WorldPoint[]
): EnhancedTarget[] {
  const groups = new Map<string, EnhancedTarget[]>();
  for (const target of targets) {
    if (target.phenomenon?.kind !== 'reflective' || !target.phenomenon.clusterId) {
      continue;
    }
    const group = groups.get(target.phenomenon.clusterId) ?? [];
    group.push(target);
    groups.set(target.phenomenon.clusterId, group);
  }
  return (
    [...groups.values()]
      .filter((group) => group.length >= 2)
      .sort((a, b) => {
        const clearance = (group: EnhancedTarget[]) =>
          Math.min(
            ...group.flatMap((target) =>
              hazards.map((hazard) =>
                Math.hypot(target.position.x - hazard.x, target.position.y - hazard.y)
              )
            )
          );
        return clearance(b) - clearance(a);
      })[0] ?? []
  );
}

/** Project a live asteroid through the production camera before a real browser tap. */
export async function asteroidScreenPoint(
  page: import('playwright').Page,
  id: string
): Promise<WorldPoint> {
  return page.evaluate(
    ({ targetId, scale }) => {
      const gc = window.gameController;
      const target = gc
        ?.getAsteroidToolsController()
        .getState()
        .targets.find((row) => row.id === targetId);
      const ship = gc?.getCurrPlayer()?.ship;
      const canvas = document.getElementById('gameCanvas');
      if (!target || !ship || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Target projection unavailable');
      }
      const rect = canvas.getBoundingClientRect();
      // Pointer events and the camera both use logical CSS pixels, independent
      // of the canvas's higher-density backing bitmap.
      return {
        x: rect.left + rect.width / 2 + (target.position.x - ship.position.x) * scale,
        y: rect.top + rect.height / 2 + (target.position.y - ship.position.y) * scale,
      };
    },
    { targetId: id, scale: PLAYFIELD_CLOSE_SCALE }
  );
}

export async function flickPlayfield(
  page: import('playwright').Page,
  dx: number,
  dy: number
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const canvas = await page.locator('#gameCanvas').boundingBox();
    if (!canvas) {
      throw new Error('Canvas unavailable');
    }
    const x = canvas.x + canvas.width / 2;
    const y = canvas.y + canvas.height / 2;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 7 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + dx, y: y + dy, id: 7 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

export async function selectAsteroidWithKeyboard(
  page: import('playwright').Page,
  id: string
): Promise<void> {
  await page.keyboard.press('Escape');
  const count = await page.evaluate(
    () => window.gameController?.getAsteroidToolsController().getState().targets.length ?? 0
  );
  for (let index = 0; index < count; index++) {
    await page.keyboard.press('KeyT');
    const selected = await page.evaluate(
      () => window.gameController?.getAsteroidToolsController().getState().selectedTargetId
    );
    if (selected === id) {
      return;
    }
  }
  throw new Error(`Keyboard targeting did not select ${id} after ${count} targets`);
}
