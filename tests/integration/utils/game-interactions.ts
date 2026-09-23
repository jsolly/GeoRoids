import type { Page } from 'playwright';
import { WORLD } from '../../../shared/world';
import type { EquipmentId, HaulerUtilityId } from '../../../shared-types';
import { HAULER_UTILITY_STORAGE_KEY } from '../../../src/entities/ship/haulerUtility';
import { describeDeathCause } from '../../../src/utils/deathCause';
import { TestConfig, TestSelectors } from './test-config';
import { arrangeCrewField, getWorldDiagnostics, placePlayer } from './test-server-control';

type CrashAsteroidCandidate = {
  x: number;
  y: number;
  id: string;
  radius: number;
};

function compareCrashTargets(
  left: CrashAsteroidCandidate,
  right: CrashAsteroidCandidate,
  hazards: Array<{ x: number; y: number; radius: number }>,
  impact: { x: number; y: number }
): number {
  const actorClearance = (candidate: CrashAsteroidCandidate) =>
    hazards.length
      ? Math.min(
          ...hazards.map(
            (hazard) =>
              Math.hypot(candidate.x - hazard.x, candidate.y - hazard.y) -
              candidate.radius -
              hazard.radius
          )
        )
      : Number.POSITIVE_INFINITY;
  return (
    actorClearance(right) - actorClearance(left) ||
    Math.hypot(left.x - impact.x, left.y - impact.y) -
      Math.hypot(right.x - impact.x, right.y - impact.y)
  );
}

export class GameInteractions {
  constructor(private page: Page) {}

  /**
   * Navigate to the game
   */
  async navigateToGame(): Promise<void> {
    await this.page.goto(TestConfig.GAME_URL, {
      waitUntil: 'load',
      timeout: 30000,
    });
  }

  /**
   * Wait for and click the start game button
   */
  async startGame(): Promise<void> {
    await this.page.locator('#start-screen').waitFor({ state: 'visible', timeout: 10000 });

    const playButton = this.page.locator('#start-game');
    await playButton.waitFor({ state: 'visible', timeout: 30000 });
    await playButton.click();

    await this.page.locator('#gameArea').waitFor({ state: 'visible', timeout: 5000 });
  }

  /**
   * Wait for the game to be fully initialized
   */
  async waitForGameInitialization(timeoutMs: number = TestConfig.GAME_INIT_TIMEOUT): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const gameController = window.gameController;
        if (!gameController) {
          return false;
        }

        const gameArea = document.querySelector('#gameArea');
        const canvas = document.querySelector('#gameCanvas');
        if (!gameArea || !canvas) {
          return false;
        }

        const localPlayer = gameController.getPlayerManager().getLocalPlayer();
        const networkManager = gameController.getNetworkManager();
        return Boolean(localPlayer && networkManager.isConnected);
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );
  }

  /**
   * Verify the game canvas is visible
   */
  async verifyGameCanvas(): Promise<void> {
    await this.page.waitForFunction(() => {
      const canvas = document.querySelector('#gameCanvas');
      if (!canvas) {
        return false;
      }

      const computedStyle = window.getComputedStyle(canvas);
      const rect = canvas.getBoundingClientRect();

      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        computedStyle.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
  }

  /**
   * Fire lasers multiple times using mouse clicks (left mouse button)
   */
  async fireLasersWithMouse(count: number, delayMs: number = 500): Promise<void> {
    const canvas = this.page.locator(TestSelectors.GAME_CANVAS);
    await canvas.waitFor({ state: 'visible', timeout: 5000 });

    for (let i = 1; i <= count; i++) {
      const box = await canvas.boundingBox();
      if (!box) {
        throw new Error('Canvas bounding box unavailable for mouse fire');
      }
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down({ button: 'left' });
      try {
        await this.waitForAnimationFrames(10);
      } finally {
        await this.page.mouse.up({ button: 'left' });
      }
      await this.waitForAnimationFrames(5);
      if (i < count && delayMs > 0) {
        await this.page.waitForTimeout(delayMs);
      }
    }
  }

  /** Poll until local ship health matches the expected value. */
  async waitForShipHealth(expected: number, timeoutMs = 15000): Promise<void> {
    await this.page
      .waitForFunction(
        (expectedHealth) => {
          const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
          return ship?.health === expectedHealth;
        },
        expected,
        { timeout: timeoutMs, polling: 100 }
      )
      .catch(async () => {
        throw new Error(
          `Timed out waiting for ship health ${expected} (got ${await this.getShipHealth()})`
        );
      });
  }

  /** Hold a real movement key while the browser runs the game. */
  async holdMovementKey(
    key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp',
    durationMs = 1000
  ): Promise<void> {
    await this.page.keyboard.down(key);
    try {
      await this.page.waitForTimeout(durationMs);
    } finally {
      await this.page.keyboard.up(key);
    }
  }

  /** Observe browser frames, including UI frames after the game stops. */
  async waitForAnimationFrames(frameCount: number): Promise<void> {
    if (!Number.isInteger(frameCount) || frameCount < 1) {
      throw new RangeError('Frame count must be a positive integer');
    }
    await this.page.evaluate(async (frames) => {
      await new Promise<void>((resolve, reject) => {
        let remaining = frames;
        let animationFrame = 0;
        const timeout = window.setTimeout(() => {
          cancelAnimationFrame(animationFrame);
          reject(new Error(`Timed out waiting for ${frames} animation frames`));
        }, 15000);
        const observeFrame = () => {
          remaining--;
          if (remaining === 0) {
            clearTimeout(timeout);
            resolve();
          } else {
            animationFrame = requestAnimationFrame(observeFrame);
          }
        };
        animationFrame = requestAnimationFrame(observeFrame);
      });
    }, frameCount);
  }

  /** Wait until the server reports spawn protection on the local player. */
  async waitForServerSpawnProtection(timeoutMs: number = 15000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const lp = window.gameController?.getPlayerManager()?.getLocalPlayer?.();
        return (lp?.serverSpawnProtectionTimer ?? 0) > 0;
      },
      undefined,
      { timeout: timeoutMs, polling: 50 }
    );
  }

  /**
   * Verify the game area is visible
   */
  async verifyGameArea(): Promise<void> {
    await this.page.waitForFunction(() => {
      const gameArea = document.querySelector('#gameArea');
      if (!gameArea) {
        return false;
      }

      const computedStyle = window.getComputedStyle(gameArea);
      const rect = gameArea.getBoundingClientRect();

      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        computedStyle.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
  }

  /**
   * Wait for the game to load completely
   */
  async waitForGameToLoad(): Promise<void> {
    await this.navigateToGame();
    await this.startGame();
    await this.waitForGameInitialization();
    await this.waitForServerJoin();
    await this.waitForNetworkAsteroids(1);
    await this.verifyGameCanvas();
    await this.verifyGameArea();
  }

  /**
   * Wait for game to be ready (running state)
   */
  async waitForGameReady(): Promise<void> {
    await this.page.waitForFunction(
      () => window.gameController?.getIsGameRunning() === true,
      undefined,
      { timeout: 10000 }
    );
  }

  /**
   * Wait for a specific number of asteroids to be created
   */
  async waitForAsteroids(count: number, timeoutMs: number = 20000): Promise<void> {
    await this.page.waitForFunction(
      (expectedCount) => {
        const gameController = window.gameController;
        if (!gameController) {
          return false;
        }
        return gameController.getCurrRoidBelt().getRoids().length >= expectedCount;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  /**
   * Get the current asteroid count
   */
  async getAsteroidCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('gameController is not available');
      }
      return gameController.getCurrRoidBelt().getRoids().length;
    });
  }

  async getLoot(): Promise<
    Array<{ id: string; x: number; y: number; mass: number; radius: number; kind: string }>
  > {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('gameController is not available');
      }
      const loot = gameController.getLoot();
      return loot.map((drop) => ({
        id: drop.id,
        x: drop.position.x,
        y: drop.position.y,
        mass: drop.mass,
        radius: drop.radius,
        kind: drop.kind ?? 'wreckage',
      }));
    });
  }

  async getShipMass(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.mass;
    });
  }

  async getShipRadius(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.r;
    });
  }

  async getShipMaxHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.maxHealth;
    });
  }

  /**
   * Get ship health
   */
  async getShipHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      // Preserve a real health of 0 rather than reporting full health.
      return ship.health;
    });
  }

  /**
   * Get ship position
   */
  async getShipPosition(): Promise<{ x: number; y: number }> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (ship) {
        return ship.position;
      }
      throw new Error('No local ship position available');
    });
  }

  /** Get asteroid positions. (Roid exposes its radius as `r`, not `radius`.) */
  async getAsteroidPositions(): Promise<
    Array<{
      x: number;
      y: number;
      radius: number;
      id: string;
      isCollabTarget?: boolean;
      material?: string;
    }>
  > {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('gameController is not available');
      }
      return gameController
        .getCurrRoidBelt()
        .getRoids()
        .map((roid) => ({
          x: roid.position.x,
          y: roid.position.y,
          radius: roid.r,
          id: roid.id,
          isCollabTarget: roid.isCollabTarget === true,
          ...(roid.material !== undefined ? { material: roid.material } : {}),
        }));
    });
  }

  /**
   * Wait for a specified amount of time
   */
  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /**
   * Check if the ship is currently exploding
   */
  async isShipExploding(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.exploding;
    });
  }

  // ==========================================================================
  // Deterministic test primitives
  //
  // The local player's ship is fully client-simulated, so tests can place it
  // precisely and clear spawn protection to drive real, observable collisions
  // (damage, destruction, splitting, scoring) against the *playable* config —
  // no gameplay-hostile debug flags required.
  // ==========================================================================

  /** Points currently at risk in the hold. */
  getCargo(): Promise<number> {
    return this.page.evaluate(() => {
      const player = window.gameController?.getCurrPlayer();
      if (!player) {
        throw new Error('No local player available');
      }
      return player.cargo;
    });
  }

  async getLocalPlayerId(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const playerId = gc.getNetworkManager().getLocalPlayerId();
      if (!playerId) {
        throw new Error('Local player id is unavailable');
      }
      return playerId;
    });
  }

  /** Current score of the local player (server-authoritative, synced down). */
  async getScore(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      if (!gc.getPlayerManager().getLocalPlayer()) {
        throw new Error('Local player is unavailable');
      }
      return gc.getCurrScore();
    });
  }

  /**
   * Place the local ship at an exact world position, at rest, with spawn
   * protection cleared so collisions register on the next frame.
   */
  async placeShipAt(x: number, y: number): Promise<void> {
    const playerId = await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const localPlayerId = gc.getNetworkManager().getLocalPlayerId();
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!localPlayerId || !ship) {
        throw new Error('No connected local ship to place');
      }
      return localPlayerId;
    });
    const placement = await placePlayer(playerId, { x, y });
    await this.waitForFixtureMotionEpoch(placement.motionEpoch);
    await this.setPredictedShipPosition(x, y, {
      clearSpawnProtection: true,
      ...(placement.motionEpoch !== undefined
        ? { expectedMotionEpoch: placement.motionEpoch }
        : {}),
    });
  }

  private async waitForFixtureMotionEpoch(motionEpoch: number | undefined): Promise<void> {
    if (motionEpoch === undefined) {
      return;
    }
    await this.page.waitForFunction(
      (expectedEpoch) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        // Immediate collision/death can advance this connection's epoch before
        // the placement snapshot is observed by the test.
        return (ship?.playerMotion?.epoch ?? -1) >= expectedEpoch;
      },
      motionEpoch,
      { timeout: 5000, polling: 25 }
    );
  }

  private async setPredictedShipPosition(
    x: number,
    y: number,
    options: { clearSpawnProtection?: boolean; expectedMotionEpoch?: number } = {}
  ): Promise<void> {
    await this.page.evaluate(
      ({ x: worldX, y: worldY, clearSpawnProtection: clearProtection, expectedMotionEpoch }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship) {
          throw new Error('No local ship to align after fixture placement');
        }
        // Check in the same browser task as the writes so a death or respawn
        // that superseded this placement keeps its authoritative pose.
        if (expectedMotionEpoch !== undefined && ship.playerMotion?.epoch !== expectedMotionEpoch) {
          return;
        }
        ship.position = { x: worldX, y: worldY };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.angularVelocity = 0;
        if (clearProtection) {
          ship.blinkCount = 0;
          ship.spawnProtectionTimer = 0;
        }
      },
      {
        x,
        y,
        clearSpawnProtection: options.clearSpawnProtection ?? false,
        expectedMotionEpoch: options.expectedMotionEpoch,
      }
    );
  }

  /**
   * Re-arm spawn protection so the ship stops colliding (lets a test land a
   * single collision and then stop, avoiding runaway chain collisions).
   */
  async armSpawnProtection(): Promise<void> {
    await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship to protect');
      }
      ship.blinkCount = 600;
      ship.spawnProtectionTimer = 600;
    });
  }

  /** Aim the ship at a world point and fire one laser. */
  async fireLaserToward(targetX: number, targetY: number): Promise<void> {
    await this.page.evaluate(
      ({ targetX: aimX, targetY: aimY }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship) {
          throw new Error('No local ship to fire from');
        }
        const dx = aimX - ship.position.x;
        const dy = aimY - ship.position.y;
        // Forward vector is (cos a, -sin a), so invert dy.
        ship.angle = Math.atan2(-dy, dx);
        ship.canShoot = true;
        ship.shoot();
      },
      { targetX, targetY }
    );
    await this.waitForAnimationFrames(5);
  }

  /**
   * Destroy a specific asteroid with aimed lasers (no chain reaction: a laser
   * is consumed on its first hit). Each volley re-reads the live asteroid pose,
   * parks the ship outside the target hull, and chooses a clear firing lane so
   * moving asteroids cannot invalidate the shot. Resolves once the asteroid is
   * gone from the belt.
   */
  async destroyAsteroidWithLaser(
    asteroid: { x: number; y: number; id: string; radius: number },
    timeoutMs = 15000
  ): Promise<void> {
    const targetGone = () =>
      this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('gameController is not available');
        }
        return !gc
          .getCurrRoidBelt()
          .getRoids()
          .some((r) => r.id === id);
      }, asteroid.id);

    const shipRadius = await this.getShipRadius();
    const findCurrentFiringLane = async (): Promise<{
      x: number;
      y: number;
    } | null> => {
      return await this.page.evaluate(
        ({ id: asteroidId, shipRadius: localShipRadius, worldRadius }) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('gameController is not available');
          }
          const roids = gc.getCurrRoidBelt().getRoids();
          const target = roids.find((roid) => roid.id === asteroidId);
          if (!target?.position || !Number.isFinite(target.r)) {
            return null;
          }

          // Keep the ship outside both hulls with a small margin. Candidate
          // points are tested against every other asteroid so a shot has a
          // direct path to the live target.
          const gap = target.r + localShipRadius + 12;
          const targetX = target.position.x;
          const targetY = target.position.y;
          for (let index = 0; index < 16; index += 1) {
            const angle = (index * Math.PI * 2) / 16;
            const shipX = targetX - Math.cos(angle) * gap;
            const shipY = targetY - Math.sin(angle) * gap;
            if (Math.hypot(shipX, shipY) > worldRadius - localShipRadius) {
              continue;
            }

            const dx = targetX - shipX;
            const dy = targetY - shipY;
            const segmentLengthSquared = dx * dx + dy * dy;
            const clear = roids.every((roid) => {
              if (roid.id === asteroidId || !roid.position || !Number.isFinite(roid.r)) {
                return true;
              }
              const projection = Math.max(
                0,
                Math.min(
                  1,
                  ((roid.position.x - shipX) * dx + (roid.position.y - shipY) * dy) /
                    segmentLengthSquared
                )
              );
              const closestX = shipX + projection * dx;
              const closestY = shipY + projection * dy;
              return (
                Math.hypot(roid.position.x - closestX, roid.position.y - closestY) > roid.r + 8
              );
            });
            if (clear) {
              return { x: shipX, y: shipY };
            }
          }
          return null;
        },
        { id: asteroid.id, shipRadius, worldRadius: WORLD.radius }
      );
    };

    const currentTargetPosition = () =>
      this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('gameController is not available');
        }
        const target = gc
          .getCurrRoidBelt()
          .getRoids()
          .find((roid) => roid.id === id);
        return target?.position ? { x: target.position.x, y: target.position.y } : null;
      }, asteroid.id);

    // Fire ONE laser at a time, stopping as soon as the target is destroyed.
    // Bursting would let follow-up lasers destroy the freshly-spawned fragments
    // (over-destruction), so we must fire the minimum needed.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await targetGone()) {
        return;
      }
      const lane = await findCurrentFiringLane();
      if (!lane) {
        await this.waitForAnimationFrames(1);
        continue;
      }

      await this.placeShipAt(lane.x, lane.y);
      await this.armSpawnProtection(); // invulnerable to incidental collisions while shooting

      // Re-read after the authoritative position acknowledgement: the target
      // may have moved while the server processed the placement update.
      const targetPosition = await currentTargetPosition();
      if (!targetPosition) {
        return;
      }
      await this.fireLaserToward(targetPosition.x, targetPosition.y);
      // Advance the game loop so the laser travels and collision/destroy messages run.
      for (let frame = 0; frame < 45; frame++) {
        if (await targetGone()) {
          return;
        }
        await this.waitForAnimationFrames(1);
      }
    }
    throw new Error(`Asteroid ${asteroid.id} was not destroyed by laser within ${timeoutMs}ms`);
  }

  /** Wait until the local player is registered on the server (post-join). */
  async waitForServerJoin(timeoutMs = 60000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const nm = gc.getNetworkManager();
        return Boolean(
          nm.isConnected && nm.getLocalPlayerId() && gc.getPlayerManager().getLocalPlayer()
        );
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );
  }

  async waitForCombatReady(timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.page.evaluate(() => {
        const gc = window.gameController;
        const player = gc?.getPlayerManager()?.getLocalPlayer?.();
        const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!player || !ship) {
          return false;
        }
        // Client frames can advance faster than the authoritative server clock.
        // Wait for both the server expiry and the local collision window.
        return (
          ship.health > 0 &&
          !ship.exploding &&
          (ship.blinkCount ?? 0) === 0 &&
          player.serverSpawnProtectionTimer === 0
        );
      });
      if (ready) {
        return;
      }
      await this.waitForAnimationFrames(3);
    }
    throw new Error(`Timed out waiting for combat readiness after ${timeoutMs}ms`);
  }

  /** Wait until the local client has at least one synced asteroid. */
  async waitForNetworkAsteroids(minCount = 1, timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const clientCount = await this.getAsteroidCount();
      if (clientCount >= minCount) {
        return;
      }

      const world = await getWorldDiagnostics();
      if (world && world.asteroids >= minCount) {
        await this.waitForAnimationFrames(5);
      } else {
        await this.page.waitForTimeout(200);
      }
    }

    const clientCount = await this.getAsteroidCount();
    const world = await getWorldDiagnostics();
    throw new Error(
      `Timed out waiting for ${minCount} synced asteroid(s): client=${clientCount}, server=${world?.asteroids ?? 'unknown'}`
    );
  }

  /** Record the cause carried by the next authoritative death event. */
  private async observeNextDeathCause(): Promise<void> {
    await this.page.evaluate(() => {
      const testWindow = window as typeof window & { __testDeathCause?: string };
      delete testWindow.__testDeathCause;
      window.addEventListener(
        'playerDied',
        (event) => {
          const cause = (event as CustomEvent<{ deathCause?: string }>).detail?.deathCause;
          if (cause) {
            testWindow.__testDeathCause = cause;
          }
        },
        { once: true }
      );
    });
  }

  private async requireObservedDeathCause(expected: 'asteroid' | 'boundary'): Promise<void> {
    await this.page.waitForFunction(
      () => Boolean((window as typeof window & { __testDeathCause?: string }).__testDeathCause),
      undefined,
      { timeout: 5000 }
    );
    const observed = await this.page.evaluate(
      () => (window as typeof window & { __testDeathCause?: string }).__testDeathCause ?? null
    );
    const expectedLabel = describeDeathCause(expected);
    if (describeDeathCause(observed ?? undefined) !== expectedLabel) {
      throw new Error(`Expected ${expectedLabel} death, observed ${observed ?? 'no causal event'}`);
    }
  }

  /**
   * Ram distinct live asteroids until their real 25-damage impacts destroy the
   * ship. A ram destroys its asteroid, so repeatedly using one stale position
   * cannot produce sustained damage. Returns the final impact position.
   */
  private selectCrashTarget(
    field: CrashAsteroidCandidate[],
    hazards: Array<{ x: number; y: number; radius: number }>,
    lastImpact: { x: number; y: number },
    usedAsteroids: Set<string>
  ) {
    const candidates = field.filter((candidate) => !usedAsteroids.has(candidate.id));
    candidates.sort((left, right) => compareCrashTargets(left, right, hazards, lastImpact));
    return candidates[0];
  }

  async crashShipIntoAsteroidUntilDestroyed(): Promise<{ x: number; y: number }> {
    await this.observeNextDeathCause();
    const usedAsteroids = new Set<string>();
    let lastImpact = { x: 0, y: 0 };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const [field, hazards] = await Promise.all([
        this.getAsteroidPositions(),
        this.page.evaluate(() => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('gameController is not available');
          }
          const players = gc.getNetworkManager().getAllPlayers();
          return players
            .filter((player) => player.ship.health > 0 && !player.ship.exploding)
            .map((player) => ({
              x: player.ship.position.x,
              y: player.ship.position.y,
              radius: player.ship.r,
            }));
        }),
      ]);
      const target = this.selectCrashTarget(field, hazards, lastImpact, usedAsteroids);
      if (!target) {
        usedAsteroids.clear();
        await this.waitForAnimationFrames(3);
        continue;
      }
      usedAsteroids.add(target.id);
      lastImpact = { x: target.x, y: target.y };
      await this.placeShipAt(target.x, target.y);
      await this.waitForAnimationFrames(5);
      await this.page.waitForTimeout(100);

      const deathObserved = await this.page.evaluate(() =>
        Boolean((window as typeof window & { __testDeathCause?: string }).__testDeathCause)
      );
      if (deathObserved || (await this.getShipHealth()) <= 0) {
        // The authoritative event survives a respawn between test observations.
        await this.requireObservedDeathCause('asteroid');
        // Move off the impact point so split fragments cannot re-damage the
        // ship while we wait for the server respawn reposition.
        await this.page.evaluate(({ x, y }) => {
          const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
          if (!ship) {
            throw new Error('No local ship after asteroid impact');
          }
          if (ship.health > 0) {
            return;
          }
          const dist = Math.hypot(x, y) || 1;
          const step = Math.min(400, dist);
          ship.position = { x: x - (x / dist) * step, y: y - (y / dist) * step };
          ship.velocity = { x: 0, y: 0 };
        }, lastImpact);
        return lastImpact;
      }
    }
    throw new Error('Ship was not destroyed by sustained asteroid collision');
  }

  /** Distance of the local ship from the world origin (boundary is a circle). */
  async getShipDistanceFromCenter(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return Math.hypot(ship.position.x, ship.position.y);
    });
  }

  /** Wait until the server respawns the ship inside the disk and away from `deathPosition`. */
  async waitForServerRespawnAwayFrom(
    deathPosition: { x: number; y: number },
    timeoutMs = 90000,
    afterDeathPosition?: { x: number; y: number }
  ): Promise<{ x: number; y: number }> {
    const minDistance = 75;
    const afterDeath = afterDeathPosition ?? (await this.getShipPosition());
    await this.page.waitForFunction(
      ({ death, afterDeath: afterDeathPoint, minDist }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship || ship.health <= 0) {
          return false;
        }
        const fromDeath = Math.hypot(ship.position.x - death.x, ship.position.y - death.y);
        const fromAfterDeath = Math.hypot(
          ship.position.x - afterDeathPoint.x,
          ship.position.y - afterDeathPoint.y
        );
        return fromDeath > minDist && fromAfterDeath > minDist;
      },
      { death: deathPosition, afterDeath, minDist: minDistance },
      { timeout: timeoutMs, polling: 100 }
    );
    return this.getShipPosition();
  }

  /** Wait until respawn completes at a new random location away from death. */
  async waitForRandomRespawnPlacement(
    deathPosition: { x: number; y: number },
    timeoutMs = 60000
  ): Promise<{ x: number; y: number }> {
    const minDistance = 75;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.waitForAnimationFrames(20);
      const placement = await this.page.evaluate(
        ({ deathPosition: deathPoint, minDistance: minDistThreshold }) => {
          const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
          if (!ship || ship.exploding || ship.health <= 0) {
            return null;
          }
          const dist = Math.hypot(ship.position.x - deathPoint.x, ship.position.y - deathPoint.y);
          if (dist <= minDistThreshold) {
            return null;
          }
          return { x: ship.position.x, y: ship.position.y };
        },
        { deathPosition, minDistance }
      );
      if (placement) {
        return placement;
      }
    }
    const debug = await this.page.evaluate(
      ({ deathPosition: deathPoint }) => {
        const gc = window.gameController;
        const player = gc?.getPlayerManager()?.getLocalPlayer?.();
        const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        return {
          health: ship?.health,
          exploding: ship?.exploding,
          position: ship?.position,
          cargo: player?.cargo,
          purchases: player?.purchases,
          deathPosition: deathPoint,
        };
      },
      { deathPosition }
    );
    throw new Error(
      `Timed out waiting for random respawn placement (${timeoutMs}ms): ${JSON.stringify(debug)}`
    );
  }

  /** Whether the main game loop is still running. */
  async isGameRunning(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      return gc.getIsGameRunning();
    });
  }

  /** Whether the latest complete server snapshot still grants protection. */
  async isServerSpawnProtected(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const player = gc.getPlayerManager().getLocalPlayer();
      if (!player) {
        throw new Error('Local player is unavailable');
      }
      return player.serverSpawnProtectionTimer > 0;
    });
  }

  /** HUD overlay text. */
  async getHudText(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      return gc.getText();
    });
  }

  /** Whether the start screen is visible again. */
  async isStartScreenVisible(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('#start-screen');
      return el ? el.style.display !== 'none' : false;
    });
  }

  /** Count of active lasers on the local ship. */
  async getLaserCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.lasers.length;
    });
  }

  /** Local ship heading in radians. */
  async getShipAngle(): Promise<number> {
    return await this.page.evaluate(() => {
      const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!ship) {
        throw new Error('No local ship available');
      }
      return ship.angle;
    });
  }

  /** Wait until at least `minCount` remote players are visible. */
  async waitForRemotePlayers(minCount = 1, timeoutMs = 20000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        const nm = gc?.getNetworkManager();
        const localId = nm?.getLocalPlayerId();
        const remotes = (nm?.getAllPlayers() ?? []).filter(
          (p) => p.type === 'remote' && p.id !== localId
        );
        return remotes.length >= expected;
      },
      minCount,
      { timeout: timeoutMs, polling: 200 }
    );
  }

  /** Remote player ids visible to this client. */
  async getRemotePlayerIds(): Promise<string[]> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const nm = gc.getNetworkManager();
      const localId = nm.getLocalPlayerId();
      return nm
        .getAllPlayers()
        .filter((p) => p.type === 'remote' && p.id !== localId)
        .map((p) => p.id);
    });
  }

  /** Network-synced ship position for any player id known to this client. */
  async getNetworkPlayerPosition(playerId: string): Promise<{ x: number; y: number } | null> {
    return await this.page.evaluate((id) => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const local = gc.getPlayerManager().getLocalPlayer();
      if (local?.id === id) {
        return { x: local.ship.position.x, y: local.ship.position.y };
      }
      const found = gc
        .getNetworkManager()
        .getAllPlayers()
        .find((p) => p.id === id);
      if (!found?.ship) {
        return null;
      }
      return { x: found.ship.position.x, y: found.ship.position.y };
    }, playerId);
  }

  async dieOnceViaBoundary(): Promise<{ x: number; y: number }> {
    await this.waitForCombatReady();
    await this.observeNextDeathCause();
    const loot = await this.getLoot();
    const rotation = 0;
    const deathPosition = Array.from({ length: 24 }, (_, index) => {
      const angle = rotation + (index * Math.PI * 2) / 24;
      const point = {
        x: (WORLD.radius + 50) * Math.cos(angle),
        y: (WORLD.radius + 50) * Math.sin(angle),
      };
      const clearance = loot.length
        ? Math.min(...loot.map((drop) => Math.hypot(drop.x - point.x, drop.y - point.y)))
        : Number.POSITIVE_INFINITY;
      return { ...point, clearance };
    }).sort((left, right) => right.clearance - left.clearance)[0];
    if (!deathPosition) {
      throw new Error('No boundary crossing position available');
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      // Finish fixture placement inside the arena, then cross the wall through
      // the real client collision path.
      await this.placeShipAt(
        (deathPosition.x * (WORLD.radius - 100)) / (WORLD.radius + 50),
        (deathPosition.y * (WORLD.radius - 100)) / (WORLD.radius + 50)
      );
      await this.setPredictedShipPosition(deathPosition.x, deathPosition.y);
      // Observe enough collision frames for a ship whose collected mass raised
      // its health above the base 100, before waiting for the authoritative death event.
      await this.waitForAnimationFrames(4);
      await this.page.waitForTimeout(100);
      if ((await this.getShipHealth()) <= 0) {
        await this.requireObservedDeathCause('boundary');
        if (await this.isGameRunning()) {
          await this.waitForRandomRespawnPlacement(deathPosition, 25000);
        }
        return { x: deathPosition.x, y: deathPosition.y };
      }
    }
    throw new Error('boundary crossing should destroy the ship');
  }

  /** Wait until the local ship is alive again (ignores respawn placement). */
  async waitForShipAlive(timeoutMs = 25000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        return Boolean(ship && ship.health > 0 && !ship.exploding);
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );
  }

  /**
   * Fire at a remote player's ship from client A (requires both clients in game).
   * Parks the shooter adjacent to the target and fires one laser.
   */
  async fireLaserAtRemotePlayer(targetPlayerId: string, distance = 45): Promise<string> {
    const firingPoint = await this.page.evaluate(
      ({ targetId, distance: standoffDistance }) => {
        const gc = window.gameController;
        const players = gc?.getNetworkManager().getAllPlayers() ?? [];
        const target = players.find((p) => p.id === targetId);
        const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!target?.ship || !ship) {
          throw new Error('Shooter or target ship unavailable');
        }
        const tx = target.ship.position.x;
        const ty = target.ship.position.y;
        return { x: tx - standoffDistance, y: ty };
      },
      { targetId: targetPlayerId, distance }
    );
    await this.placeShipAt(firingPoint.x, firingPoint.y);
    const existing = await this.page.evaluate(
      () =>
        window.gameController
          ?.getCurrPlayer()
          ?.ship.lasers.flatMap((laser) => (laser.serverId ? [laser.serverId] : [])) ?? []
    );
    await this.page.evaluate((targetId) => {
      const gc = window.gameController;
      const players = gc?.getNetworkManager().getAllPlayers() ?? [];
      const target = players.find((p) => p.id === targetId);
      const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!target?.ship || !ship) {
        throw new Error('Shooter or target ship unavailable after fixture placement');
      }
      ship.angle = Math.atan2(
        -(target.ship.position.y - ship.position.y),
        target.ship.position.x - ship.position.x
      );
      ship.canShoot = true;
      ship.shoot();
    }, targetPlayerId);
    const acknowledgement = await this.page.waitForFunction(
      (prior) =>
        window.gameController
          ?.getCurrPlayer()
          ?.ship.lasers.find((laser) => laser.serverId && !prior.includes(laser.serverId))
          ?.serverId,
      existing,
      { timeout: 5000 }
    );
    const id = await acknowledgement.jsonValue();
    await acknowledgement.dispose();
    if (typeof id !== 'string') {
      throw new Error('Shot did not receive an authoritative projectile identity');
    }
    return id;
  }

  /** Read a remote player's synced health by id. */
  async getPlayerHealthById(playerId: string): Promise<number> {
    return await this.page.evaluate((id) => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const local = gc.getPlayerManager().getLocalPlayer();
      if (local?.id === id) {
        return local.ship.health;
      }
      const players = gc.getNetworkManager().getAllPlayers();
      const found = players.find((p) => p.id === id);
      if (!found?.ship) {
        throw new Error(`Player ${id} is unavailable`);
      }
      return found.ship.health;
    }, playerId);
  }

  async getSatellitePickups(): Promise<
    Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      state: string;
      ownerId: string | null;
      r: number;
      health: number;
      maxHealth: number;
    }>
  > {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const pickups = gc.getSatellitePickups();
      return pickups.map((pickup) => ({
        id: pickup.id,
        name: pickup.name,
        x: pickup.position.x,
        y: pickup.position.y,
        state: pickup.state,
        ownerId: pickup.ownerId,
        r: pickup.radius,
        health: pickup.health,
        maxHealth: pickup.maxHealth,
      }));
    });
  }

  async waitForSatellitePickups(count: number, timeoutMs = 25000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        return gc ? gc.getSatellitePickups().length >= expected : false;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  /** Collect real server drops before scenarios that exercise salvaged hardware. */
  async collectEquipment(equipment: readonly EquipmentId[], selected?: EquipmentId): Promise<void> {
    const playerId = await this.getLocalPlayerId();
    const epochs = await arrangeCrewField([playerId], 'equipment');
    await this.waitForFixtureMotionEpoch(epochs.get(playerId));
    for (const equipmentId of equipment) {
      const owned = await this.page.evaluate(
        (id) => window.gameController?.getCurrPlayer()?.ship.equipment.includes(id),
        equipmentId
      );
      if (owned) {
        continue;
      }
      await this.page.waitForFunction(
        (id) => window.gameController?.getLoot().some((drop) => drop.kind === id),
        equipmentId,
        { timeout: 5000 }
      );
      const position = await this.page.evaluate((id) => {
        const drop = window.gameController?.getLoot().find((item) => item.kind === id);
        if (!drop) {
          throw new Error(`Missing equipment fixture drop: ${id}`);
        }
        return { ...drop.position };
      }, equipmentId);
      await this.placeShipAt(position.x, position.y);
      try {
        await this.page.waitForFunction(
          (id) => window.gameController?.getCurrPlayer()?.ship.equipment.includes(id),
          equipmentId,
          { timeout: 5000 }
        );
      } catch (error) {
        const state = await this.page.evaluate(() => {
          const gc = window.gameController;
          const ship = gc?.getCurrPlayer()?.ship;
          return {
            ship: ship
              ? {
                  position: ship.position,
                  health: ship.health,
                  exploding: ship.exploding,
                  equipment: ship.equipment,
                  movementLocked: ship.movementLocked,
                  motion: ship.playerMotion,
                  transit: ship.furnaceTransit,
                }
              : null,
            loot: gc?.getLoot(),
          };
        });
        throw new Error(`Equipment ${equipmentId} was not collected: ${JSON.stringify(state)}`, {
          cause: error,
        });
      }
    }
    if (selected) {
      await this.page.locator('#ship-schematic-toggle').click();
      await this.page.locator('#ship-schematic-dialog').waitFor({ state: 'visible' });
      await this.page.locator(`[data-utility-id="${selected}"]`).click();
      await this.page.waitForFunction(
        (id) => {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          return ship?.haulerUtility === id || ship?.scoutUtility === id;
        },
        selected,
        { timeout: 5000 }
      );
      await this.page.locator('#ship-schematic-return').click();
    }
  }

  /** Standard one-client boot against the multiplayer server. */
  async bootGame(options?: {
    waitForCombatReady?: boolean;
    kitId?: 'scout' | 'hauler';
    haulerUtility?: HaulerUtilityId;
  }): Promise<void> {
    await this.navigateToGame();
    if (options?.haulerUtility) {
      await this.page.evaluate(
        ({ key, utility }) => {
          localStorage.setItem(key, utility);
        },
        { key: HAULER_UTILITY_STORAGE_KEY, utility: options.haulerUtility }
      );
    }
    if (options?.kitId) {
      const kitButton = this.page.locator(`[data-kit-id="${options.kitId}"]`);
      await kitButton.waitFor({ state: 'visible', timeout: 5000 });
      await kitButton.click();
    }
    await this.startGame();
    await this.waitForGameReady();
    await this.waitForServerJoin();
    await this.waitForNetworkAsteroids(1);
    if (options?.haulerUtility) {
      await this.page.waitForFunction(
        (utility) => window.gameController?.getCurrPlayer()?.ship.haulerUtility === utility,
        options.haulerUtility,
        { timeout: 5000 }
      );
    }
    if (options?.waitForCombatReady !== false) {
      await this.waitForCombatReady();
    }
  }
}
