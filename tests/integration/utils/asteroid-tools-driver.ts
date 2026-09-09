import { PLAYFIELD_CLOSE_SCALE } from '../../../src/rendering/playfieldCamera';
export type WorldPoint = { x: number; y: number };
export type EnhancedTarget = {
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

export async function driveToAsteroid(
  page: import('playwright').Page,
  asteroidId: string,
  stopGap: number,
  timeoutMs = 20_000
): Promise<{ gap: number; distance: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { gap: number; distance: number } | undefined;
  await page.keyboard.down('KeyW');
  try {
    while (Date.now() < deadline) {
      const navigation = await page.evaluate(
        ({ id, requiredGap }) => {
          const controller = window.gameController;
          const ship = controller?.getCurrShip();
          const rock = controller
            ?.getCurrRoidBelt()
            .getRoids()
            .find((candidate) => candidate.id === id);
          if (!ship || !rock) {
            return null;
          }
          const dx = rock.position.x - ship.position.x;
          const dy = rock.position.y - ship.position.y;
          const distance = Math.hypot(dx, dy);
          const gap = distance - ship.r - rock.r;
          if (gap > requiredGap) {
            // The held W key supplies the real thrust input. Re-aiming the
            // current ship is equivalent to the player's aim direction and
            // keeps the route pointed at the live authoritative rock pose.
            ship.angle = Math.atan2(-dy, dx);
            ship.thrusting = true;
          } else {
            ship.thrusting = false;
          }
          return { gap, distance, alive: ship.health > 0 && !ship.exploding };
        },
        { id: asteroidId, requiredGap: stopGap }
      );
      if (!navigation) {
        throw new Error(`Asteroid ${asteroidId} disappeared while piloting`);
      }
      last = navigation;
      if (!navigation.alive) {
        throw new Error(`Pilot died while approaching asteroid ${asteroidId}`);
      }
      if (navigation.gap <= stopGap) {
        break;
      }
      // Let the browser's real RAF and the negotiated server clock advance.
      // Calling updateGame manually here double-advances enhanced movement.
      await page.waitForTimeout(50);
    }
  } finally {
    await page.keyboard.up('KeyW');
    await page.evaluate(() => {
      const ship = window.gameController?.getCurrShip();
      if (ship) {
        ship.thrusting = false;
      }
    });
  }
  if (!last || last.gap > stopGap) {
    throw new Error(`Could not reach asteroid ${asteroidId} within ${timeoutMs}ms`);
  }
  await page.waitForTimeout(100);
  return last;
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
      const point = {
        x: (target.position.x - ship.position.x) * scale + canvas.width / 2,
        y: (target.position.y - ship.position.y) * scale + canvas.height / 2,
      };
      const rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (point.x * rect.width) / canvas.width,
        y: rect.top + (point.y * rect.height) / canvas.height,
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
