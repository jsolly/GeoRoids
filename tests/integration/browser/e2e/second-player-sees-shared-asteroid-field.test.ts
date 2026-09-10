import { expect, test } from 'vitest';
import { ROID } from '../../../../src/constants';
import { getGameBoundary } from '../../../../src/physics/boundary';
import {
  countRocksOnCanvas,
  PLAYFIELD_CLOSE_SCALE,
} from '../../../../src/rendering/playfieldCamera';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager } = createBrowserScenarioHooks();
type Field = Awaited<ReturnType<GameInteractions['getAsteroidPositions']>>;

async function onCanvasAsteroidCount(game: GameInteractions): Promise<number> {
  const [ship, field, canvas] = await Promise.all([
    game.getShipPosition(),
    game.getAsteroidPositions(),
    game.getCanvasSize(),
  ]);
  const roids = field.map((roid) => ({ position: { x: roid.x, y: roid.y }, r: roid.radius }));
  return countRocksOnCanvas(roids, ship, canvas, PLAYFIELD_CLOSE_SCALE);
}

function survivingRockMoved(before: Field, after: Field): boolean {
  return before.some((start) => {
    const later = after.find((rock) => rock.id === start.id);
    return later !== undefined && Math.hypot(later.x - start.x, later.y - start.y) > 1;
  });
}

async function parkOutsideBelt(game: GameInteractions, side: number): Promise<void> {
  // Leave the initial bot-combat area immediately, without disabling gameplay.
  const x = side * (ROID.FIELD_RADIUS + 500);
  expect(Math.abs(x) + (await game.getShipRadius())).toBeLessThan(getGameBoundary().radius);
  await game.placeShipAt(x, 0);
}

test(
  'second player sees shared asteroid field',
  async () => {
    const page1 = browserManager.getCurrentPage();
    if (!page1) {
      throw new Error('Page 1 not available');
    }
    await browserManager.createPage();
    const page2 = browserManager.getCurrentPage();
    if (!page2) {
      throw new Error('Page 2 not available');
    }
    const game1 = new GameInteractions(page1);
    const game2 = new GameInteractions(page2);

    await game1.bootGame({ waitForCombatReady: false });
    await parkOutsideBelt(game1, 1);
    await game2.bootGame({ waitForCombatReady: false });
    await parkOutsideBelt(game2, -1);

    // Compare contemporary observations. Destruction/splitting may legitimately
    // change the field while the second browser boots or between network ticks.
    await expect
      .poll(
        async () => {
          const [first, second] = await Promise.all([
            game1.getAsteroidPositions(),
            game2.getAsteroidPositions(),
          ]);
          if (!first.length || first.length !== second.length) {
            return false;
          }
          return first.every((rock) => {
            const peer = second.find((other) => other.id === rock.id);
            return (
              peer !== undefined && Math.abs(peer.x - rock.x) < 80 && Math.abs(peer.y - rock.y) < 80
            );
          });
        },
        { timeout: 5000, message: 'both clients should share current asteroid IDs and poses' }
      )
      .toBe(true);

    const firstField = await game1.getAsteroidPositions();
    await expect
      .poll(async () => survivingRockMoved(firstField, await game1.getAsteroidPositions()), {
        timeout: 2500,
        message: 'existing shared asteroids should keep moving',
      })
      .toBe(true);

    // At fixed close zoom, a stationary ship need not see distant minimap dots.
    // Intentionally place both cameras near the same surviving rock, choosing the
    // greatest clearance from live NPCs and leaving space outside its hull.
    const [field, bots, satellites, radius1, radius2] = await Promise.all([
      game1.getAsteroidPositions(),
      game1.getBots(),
      game1.getSatellites(),
      game1.getShipRadius(),
      game2.getShipRadius(),
    ]);
    const enemies = [...bots, ...satellites].filter(
      (enemy) => !enemy.exploding && enemy.health > 0
    );
    const clearance = (rock: Field[number]) =>
      Math.min(...enemies.map((enemy) => Math.hypot(enemy.x - rock.x, enemy.y - rock.y)));
    const focus = [...field].sort((a, b) => clearance(b) - clearance(a))[0];
    expect(focus, 'a surviving shared rock should be available for camera focus').toBeDefined();
    if (!focus) {
      throw new Error('No surviving shared rock was available for camera focus');
    }
    const outward = Math.atan2(focus.y, focus.x);
    const gap = focus.radius + Math.max(radius1, radius2) + 100;
    const pose = { x: focus.x + Math.cos(outward) * gap, y: focus.y + Math.sin(outward) * gap };
    const separation = Math.max(radius1, radius2) + 30;
    const tangent = { x: -Math.sin(outward) * separation, y: Math.cos(outward) * separation };
    expect(Math.hypot(pose.x, pose.y) + separation + Math.max(radius1, radius2)).toBeLessThan(
      getGameBoundary().radius
    );
    await Promise.all([
      game1.placeShipAt(pose.x + tangent.x, pose.y + tangent.y),
      game2.placeShipAt(pose.x - tangent.x, pose.y - tangent.y),
    ]);
    await expect
      .poll(() => onCanvasAsteroidCount(game1), {
        timeout: 2500,
        message: 'focused tab 1 should show nearby rocks',
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => onCanvasAsteroidCount(game2), {
        timeout: 2500,
        message: 'focused tab 2 should show nearby rocks',
      })
      .toBeGreaterThan(0);
  },
  TestConfig.DEFAULT_TIMEOUT * 2
);
