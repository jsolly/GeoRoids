import type { Page } from 'playwright';
import { describeDeathCause } from '../../../src/utils/deathCause';
import { TestConfig, TestSelectors } from './test-config';
import type { BotShotArrangement } from './test-server-control';
import {
  arrangeBotShot,
  getWorldDiagnostics,
  isBotShieldActiveError,
  placePlayer,
} from './test-server-control';

const BOT_SHOT_SETUP_TIMEOUT_MS = 15_000;

type BotShieldWaitResult = 'clear' | 'dead';

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

  /**
   * Get the current number of lives
   */
  async getLives(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const nm = gc.getNetworkManager();
      const localId = nm.getLocalPlayerId();
      const fromNetwork = localId ? nm.getPlayer(localId) : undefined;
      const local = gc.getPlayerManager().getLocalPlayer();
      const player = fromNetwork ?? local;
      if (!player) {
        throw new Error('No local player available');
      }
      return player.lives;
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

  /** Server-assigned id of the local player (used as attackerId in damage). */
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
      const playerId = gc.getNetworkManager().getLocalPlayerId();
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!playerId || !ship) {
        throw new Error('No connected local ship to place');
      }
      return playerId;
    });
    const placement = await placePlayer(playerId, { x, y });
    await this.waitForFixtureMotionEpoch(placement.motionEpoch);
    await this.setPredictedShipPosition(x, y, { clearSpawnProtection: true });
  }

  private async waitForFixtureMotionEpoch(motionEpoch: number | undefined): Promise<void> {
    if (motionEpoch === undefined) {
      return;
    }
    await this.page.waitForFunction(
      (expectedEpoch) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        return ship?.asteroidMotion?.epoch === expectedEpoch;
      },
      motionEpoch,
      { timeout: 5000, polling: 25 }
    );
  }

  private async setPredictedShipPosition(
    x: number,
    y: number,
    options: { clearSpawnProtection?: boolean } = {}
  ): Promise<void> {
    await this.page.evaluate(
      ({ x, y, clearSpawnProtection }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship) {
          throw new Error('No local ship to align after fixture placement');
        }
        ship.position = { x, y };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.angularVelocity = 0;
        if (clearSpawnProtection) {
          ship.blinkCount = 0;
          ship.spawnProtectionTimer = 0;
        }
      },
      { x, y, clearSpawnProtection: options.clearSpawnProtection ?? false }
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

  /** Snapshot of all satellites the client currently knows about. */
  async getSatellites(): Promise<
    Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      health: number;
      maxHealth: number;
      exploding: boolean;
      r: number;
      laserCount: number;
    }>
  > {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const satellites = gc.getSatellites();
      return satellites.map((sat) => ({
        id: sat.id,
        name: sat.name,
        x: sat.position.x,
        y: sat.position.y,
        health: sat.health,
        maxHealth: sat.maxHealth,
        exploding: sat.exploding,
        r: sat.radius,
        laserCount: sat.lasers?.length ?? 0,
      }));
    });
  }

  /** Wait until at least `count` satellites are known to the client. */
  async waitForSatellites(count: number, timeoutMs = 25000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        return gc ? gc.getSatellites().length >= expected : false;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  async attackSatelliteWithLasers(
    satelliteId: string,
    shots = 8
  ): Promise<{ minHealthObserved: number; everExploding: boolean; scoreGain: number }> {
    const startScore = await this.getScore();
    let minHealthObserved = Number.POSITIVE_INFINITY;
    let everExploding = false;

    for (let i = 0; i < shots; i++) {
      const sample = await this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('gameController is not available');
        }
        const sat = gc?.getSatellites().find((s) => s.id === id);
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
        if (!sat) {
          return null;
        }
        if (!ship) {
          throw new Error('No local ship available');
        }
        return {
          health: sat.health,
          exploding: sat.exploding,
          firingPoint: { x: sat.position.x - 45, y: sat.position.y },
        };
      }, satelliteId);

      if (sample) {
        await this.placeShipAt(sample.firingPoint.x, sample.firingPoint.y);
        await this.armSpawnProtection();
        await this.page.evaluate((id) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('gameController is not available');
          }
          const sat = gc.getSatellites().find((s) => s.id === id);
          const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
          if (!sat || sat.health <= 0 || sat.exploding) {
            return;
          }
          if (!ship) {
            throw new Error('No local ship available');
          }
          ship.angle = Math.atan2(
            -(sat.position.y - ship.position.y),
            sat.position.x - ship.position.x
          );
          ship.canShoot = true;
          ship.shoot();
        }, satelliteId);
        minHealthObserved = Math.min(minHealthObserved, sample.health);
        everExploding = everExploding || sample.exploding;
      }
      await this.page.waitForTimeout(160);

      const after = await this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('gameController is not available');
        }
        const sat = gc.getSatellites().find((s) => s.id === id);
        return sat ? { health: sat.health, exploding: sat.exploding } : null;
      }, satelliteId);
      if (after) {
        minHealthObserved = Math.min(minHealthObserved, after.health);
        everExploding = everExploding || after.exploding;
        if (after.exploding || after.health <= 0) {
          break;
        }
      }
    }

    const endScore = await this.getScore();
    if (!Number.isFinite(minHealthObserved)) {
      throw new Error(`No live health observation was available for satellite ${satelliteId}`);
    }
    return {
      minHealthObserved,
      everExploding,
      scoreGain: endScore - startScore,
    };
  }

  async pinShipOnSatellite(satelliteId: string, durationMs = 2500): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const position = await this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('gameController is not available');
        }
        const sat = gc.getSatellites().find((s) => s.id === id);
        return sat ? { x: sat.position.x, y: sat.position.y } : null;
      }, satelliteId);
      if (!position) {
        return;
      }
      await this.placeShipAt(position.x, position.y);
      await this.page.waitForTimeout(100);
    }
  }

  /** Snapshot of all bots the client currently knows about. */
  async getBots(): Promise<
    Array<{
      id: string;
      x: number;
      y: number;
      health: number;
      maxHealth: number;
      exploding: boolean;
      r: number;
      factionId?: 'ion' | 'ember';
    }>
  > {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      const players = gc.getNetworkManager().getAllPlayers();
      return players
        .filter((p) => p.type === 'bot')
        .map((p) => ({
          id: p.id,
          x: p.ship.position.x,
          y: p.ship.position.y,
          health: p.ship.health,
          maxHealth: p.ship.maxHealth,
          exploding: p.ship.exploding,
          r: p.ship.r,
          ...((p.factionId ?? p.ship.factionId)
            ? { factionId: p.factionId ?? p.ship.factionId }
            : {}),
        }));
    });
  }

  /** Resolve a currently alive bot on the opposite assigned soft faction. */
  async getHostileBotId(timeoutMs = 25000): Promise<string> {
    await this.page.waitForFunction(
      () => {
        const gc = window.gameController;
        const local = gc?.getPlayerManager()?.getLocalPlayer?.();
        const localFaction = local?.factionId ?? local?.ship?.factionId;
        if (!localFaction) {
          return false;
        }
        const players = gc?.getNetworkManager().getAllPlayers() ?? [];
        return players.some((player) => {
          const faction = player.factionId ?? player.ship?.factionId;
          return (
            player.type === 'bot' &&
            player.ship &&
            player.ship.health > 0 &&
            !player.ship.exploding &&
            faction &&
            faction !== localFaction
          );
        });
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );

    return await this.page.evaluate(() => {
      const gc = window.gameController;
      const local = gc?.getPlayerManager()?.getLocalPlayer?.();
      const localFaction = local?.factionId ?? local?.ship?.factionId;
      const players = gc?.getNetworkManager().getAllPlayers() ?? [];
      const hostile = players.find((player) => {
        const faction = player.factionId ?? player.ship?.factionId;
        return (
          player.type === 'bot' &&
          player.ship &&
          player.ship.health > 0 &&
          !player.ship.exploding &&
          faction &&
          faction !== localFaction
        );
      });
      if (!hostile?.id) {
        throw new Error(
          `No alive hostile bot found for local faction ${localFaction ?? 'unknown'}`
        );
      }
      return hostile.id;
    });
  }

  /** Wait for a live bot's real laser shield to expire before the next shot. */
  async waitForBotShieldToClear(
    botId: string,
    timeoutMs = BOT_SHOT_SETUP_TIMEOUT_MS
  ): Promise<BotShieldWaitResult> {
    const state = await this.page.waitForFunction(
      (id) => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const players = gc.getNetworkManager().getAllPlayers();
        const bot = players.find((player) => player.id === id);
        if (!bot?.ship) {
          return false;
        }
        if (bot.ship.exploding || bot.ship.health <= 0) {
          return 'dead';
        }
        return !bot.ship.shieldActive && (bot.ship.shieldTime ?? 0) <= 0 ? 'clear' : false;
      },
      botId,
      { timeout: timeoutMs, polling: 100 }
    );
    try {
      const result: unknown = await state.jsonValue();
      if (result !== 'clear' && result !== 'dead') {
        throw new Error(`Bot ${botId} shield wait returned an invalid state`);
      }
      return result;
    } finally {
      await state.dispose();
    }
  }

  /** Wait until at least `count` bots are known to the client. */
  async waitForBots(count: number, timeoutMs = 25000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const players = gc.getNetworkManager().getAllPlayers();
        return players.filter((p) => p.type === 'bot').length >= expected;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  /** Aim the ship at a world point and fire one laser. */
  async fireLaserToward(targetX: number, targetY: number): Promise<void> {
    await this.page.evaluate(
      ({ targetX, targetY }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship) {
          throw new Error('No local ship to fire from');
        }
        const dx = targetX - ship.position.x;
        const dy = targetY - ship.position.y;
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
        ({ id, shipRadius }) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('gameController is not available');
          }
          const roids = gc.getCurrRoidBelt().getRoids();
          const target = roids.find((roid) => roid.id === id);
          if (!target?.position || !Number.isFinite(target.r)) {
            return null;
          }

          // Keep the ship outside both hulls with a small margin. Candidate
          // points are tested against every other asteroid so a shot has a
          // direct path to the live target.
          const gap = target.r + shipRadius + 12;
          const targetX = target.position.x;
          const targetY = target.position.y;
          for (let index = 0; index < 16; index += 1) {
            const angle = (index * Math.PI * 2) / 16;
            const shipX = targetX - Math.cos(angle) * gap;
            const shipY = targetY - Math.sin(angle) * gap;
            if (Math.hypot(shipX, shipY) > 3000) {
              continue;
            }

            const dx = targetX - shipX;
            const dy = targetY - shipY;
            const segmentLengthSquared = dx * dx + dy * dy;
            const clear = roids.every((roid) => {
              if (roid.id === id || !roid.position || !Number.isFinite(roid.r)) {
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
        { id: asteroid.id, shipRadius }
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

  /**
   * Fire repeated, re-aimed lasers at a bot until it is destroyed (or
   * the shot budget is exhausted). Returns what was observed so the caller can
   * assert on real damage/kill signals.
   */
  async attackBotWithLasers(
    botId: string,
    shots = 8
  ): Promise<{
    minHealthObserved: number;
    everExploding: boolean;
    scoreGain: number;
    firstShotHealthBefore: number;
  }> {
    const startScore = await this.getScore();
    const playerId = await this.getLocalPlayerId();
    const retreat = { x: -1800, y: -1800 };
    let minHealthObserved = Number.POSITIVE_INFINITY;
    let everExploding = false;
    let fired = 0;
    let firstShotHealthBefore: number | undefined;

    while (fired < shots) {
      const setupDeadline = Date.now() + BOT_SHOT_SETUP_TIMEOUT_MS;
      let arrangement: BotShotArrangement | undefined;
      while (!arrangement) {
        const remainingMs = setupDeadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`Timed out arranging bot ${botId} after shield synchronization`);
        }

        const shieldState = await this.waitForBotShieldToClear(botId, remainingMs);
        if (shieldState === 'dead') {
          if (fired === 0) {
            throw new Error(`Bot ${botId} became terminal before the first fixture shot`);
          }
          minHealthObserved = Math.min(minHealthObserved, 0);
          break;
        }

        const requestTimeoutMs = setupDeadline - Date.now();
        if (requestTimeoutMs <= 0) {
          throw new Error(`Timed out arranging bot ${botId} after shield synchronization`);
        }
        try {
          arrangement = await arrangeBotShot(playerId, botId, requestTimeoutMs);
        } catch (error) {
          if (!isBotShieldActiveError(error)) {
            throw error;
          }
        }
      }
      if (!arrangement) {
        break;
      }
      await this.waitForFixtureMotionEpoch(arrangement.motionEpoch);
      await this.setPredictedShipPosition(
        arrangement.playerPosition.x,
        arrangement.playerPosition.y
      );
      const sample = await this.page.waitForFunction(
        ({ id, expectedHealth, expectedPosition }) => {
          const players = window.gameController?.getNetworkManager().getAllPlayers() ?? [];
          const bot = players.find((player) => player.id === id);
          if (!bot?.ship) {
            return false;
          }
          const dying = bot.ship.exploding || bot.ship.health <= 0;
          if (
            !dying &&
            (bot.ship.health !== expectedHealth ||
              Math.hypot(
                bot.ship.position.x - expectedPosition.x,
                bot.ship.position.y - expectedPosition.y
              ) > 20)
          ) {
            return false;
          }
          return {
            health: bot.ship.health,
            exploding: bot.ship.exploding,
            position: { x: bot.ship.position.x, y: bot.ship.position.y },
          };
        },
        {
          id: botId,
          expectedHealth: arrangement.botHealth,
          expectedPosition: arrangement.botPosition,
        },
        { timeout: 2000, polling: 20 }
      );
      const before = await sample.jsonValue();
      if (!before) {
        throw new Error(`Bot ${botId} was unavailable after fixture arrangement`);
      }
      if (firstShotHealthBefore === undefined) {
        firstShotHealthBefore = arrangement.botHealth;
      }
      minHealthObserved = Math.min(minHealthObserved, before.health);
      everExploding = everExploding || before.exploding;
      if (before.exploding || before.health <= 0) {
        break;
      }

      await this.fireLaserToward(before.position.x, before.position.y);
      fired++;
      await this.placeShipAt(retreat.x, retreat.y);
      const impactDeadline = Date.now() + 1000;
      while (Date.now() < impactDeadline) {
        await this.page.waitForTimeout(50);
        const after = await this.page.evaluate((id) => {
          const players = window.gameController?.getNetworkManager().getAllPlayers() ?? [];
          const bot = players.find((p) => p.id === id);
          return bot ? { health: bot.ship.health, exploding: bot.ship.exploding } : null;
        }, botId);
        if (!after) {
          throw new Error(`Bot ${botId} disappeared while waiting for laser impact`);
        }
        minHealthObserved = Math.min(minHealthObserved, after.health);
        everExploding = everExploding || after.exploding;
        if (after.exploding || after.health <= 0) {
          break;
        }
        if (after.health < before.health) {
          break;
        }
      }
      // Once the selected hostile bot is dead, stop issuing shots. The server
      // keeps bots firing during the same window, so continuing a lethal
      // volley can kill the fixture ship and make the next pose acknowledgement
      // impossible while it is exploding/respawning.
      if (everExploding || minHealthObserved <= 0) {
        break;
      }
    }

    if (!Number.isFinite(minHealthObserved)) {
      throw new Error(`No live health observation was available for bot ${botId}`);
    }
    if (fired === 0) {
      throw new Error(`No real laser was fired at hostile bot ${botId}`);
    }
    if (firstShotHealthBefore === undefined) {
      throw new Error(`No arranged health observation was available for bot ${botId}`);
    }
    const endScore = await this.getScore();
    return {
      minHealthObserved,
      everExploding,
      scoreGain: endScore - startScore,
      firstShotHealthBefore,
    };
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

  /** Record the cause carried by the next authoritative life-loss event. */
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
    const observed = await this.page.evaluate(
      () => (window as typeof window & { __testDeathCause?: string }).__testDeathCause ?? null
    );
    const expectedLabel = describeDeathCause(expected);
    if (observed !== expectedLabel) {
      throw new Error(`Expected ${expectedLabel} death, observed ${observed ?? 'no causal event'}`);
    }
  }

  /**
   * Ram distinct live asteroids until their real 25-damage impacts destroy the
   * ship. A ram destroys its asteroid, so repeatedly using one stale position
   * cannot produce sustained damage. Returns the final impact position.
   */
  async crashShipIntoAsteroidUntilDestroyed(): Promise<{ x: number; y: number }> {
    const startLives = await this.getLives();
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
          const satellites = gc.getSatellites();
          return [
            ...players
              .filter((player) => player.ship.health > 0 && !player.ship.exploding)
              .map((player) => ({
                x: player.ship.position.x,
                y: player.ship.position.y,
                radius: player.ship.r,
              })),
            ...satellites
              .filter((satellite) => satellite.health > 0 && !satellite.exploding)
              .map((satellite) => ({
                x: satellite.position.x,
                y: satellite.position.y,
                radius: satellite.radius,
              })),
          ];
        }),
      ]);
      const actorClearance = (candidate: (typeof field)[number]) =>
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
      const target = field
        .filter((candidate) => !usedAsteroids.has(candidate.id))
        .sort(
          (left, right) =>
            actorClearance(right) - actorClearance(left) ||
            Math.hypot(left.x - lastImpact.x, left.y - lastImpact.y) -
              Math.hypot(right.x - lastImpact.x, right.y - lastImpact.y)
        )[0];
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

      if ((await this.getLives()) < startLives) {
        // Move off the impact point so split fragments cannot re-damage the
        // ship while we wait for the server respawn reposition.
        await this.page.evaluate(({ x, y }) => {
          const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
          if (!ship) {
            throw new Error('No local ship after asteroid impact');
          }
          const dist = Math.sqrt(x * x + y * y) || 1;
          const step = Math.min(400, dist);
          ship.position = { x: x - (x / dist) * step, y: y - (y / dist) * step };
          ship.velocity = { x: 0, y: 0 };
        }, lastImpact);
        await this.requireObservedDeathCause('asteroid');
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
      return Math.sqrt(ship.position.x * ship.position.x + ship.position.y * ship.position.y);
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
      ({ death, afterDeath, minDist }) => {
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        if (!ship || ship.health <= 0) {
          return false;
        }
        const fromDeath = Math.hypot(ship.position.x - death.x, ship.position.y - death.y);
        const fromAfterDeath = Math.hypot(
          ship.position.x - afterDeath.x,
          ship.position.y - afterDeath.y
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
        ({ deathPosition, minDistance }) => {
          const ship = window.gameController?.getPlayerManager()?.getLocalPlayer?.()?.ship;
          if (!ship || ship.exploding || ship.health <= 0) {
            return null;
          }
          const dist = Math.hypot(
            ship.position.x - deathPosition.x,
            ship.position.y - deathPosition.y
          );
          if (dist <= minDistance) {
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
      ({ deathPosition }) => {
        const gc = window.gameController;
        const player = gc?.getPlayerManager()?.getLocalPlayer?.();
        const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
        return {
          health: ship?.health,
          exploding: ship?.exploding,
          position: ship?.position,
          lives: player?.lives,
          deathPosition,
        };
      },
      { deathPosition }
    );
    throw new Error(
      `Timed out waiting for random respawn placement (${timeoutMs}ms): ${JSON.stringify(debug)}`
    );
  }

  /** Number of active lasers on the local ship. */
  async getLocalLaserCount(): Promise<number> {
    return this.getLaserCount();
  }

  /** @deprecated Use waitForRandomRespawnPlacement when asserting respawn location. */
  async waitForShipRespawn(
    deathPosition?: { x: number; y: number },
    timeoutMs = 60000
  ): Promise<{ x: number; y: number }> {
    if (deathPosition) {
      return this.waitForRandomRespawnPlacement(deathPosition, timeoutMs);
    }
    await this.waitForShipAlive(timeoutMs);
    return this.getShipPosition();
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

  /** Kill banner text from GameStateManager (empty when inactive). */
  async getKillMessage(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('gameController is not available');
      }
      return gc.getGameStateManager().getKillMessage();
    });
  }

  /** HUD overlay text (game over, death messages). */
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
      const el = document.getElementById('start-screen');
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

  /** Wait until at least `minCount` remote human players are visible. */
  async waitForRemoteHumanPlayers(minCount = 1, timeoutMs = 20000): Promise<void> {
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

  /** Remote human player ids visible to this client. */
  async getRemoteHumanPlayerIds(): Promise<string[]> {
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

  /** Pin the local ship on a bot so ship-to-ship collision damage applies. */
  async pinShipOnBot(botId: string, durationMs = 2500): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const position = await this.page.evaluate((id) => {
        const players = window.gameController?.getNetworkManager().getAllPlayers() ?? [];
        const bot = players.find((p) => p.id === id);
        return bot?.ship ? { x: bot.ship.position.x, y: bot.ship.position.y } : null;
      }, botId);
      if (!position) {
        return;
      }
      await this.placeShipAt(position.x, position.y);
      await this.page.waitForTimeout(100);
    }
  }

  /** Poll until a bot finishes respawning at full health. */
  async waitForBotRespawn(botId: string, timeoutMs = 20000): Promise<{ x: number; y: number }> {
    await this.page.waitForFunction(
      (id) => {
        const players = window.gameController?.getNetworkManager().getAllPlayers() ?? [];
        const bot = players.find((p) => p.id === id);
        return Boolean(
          bot?.ship &&
            bot.ship.health > 0 &&
            // The authoritative respawn window survives immediate pickup growth
            // or new damage; full health is only momentary in the live arena.
            bot.serverSpawnProtectionTimer > 0 &&
            !bot.ship.exploding
        );
      },
      botId,
      { timeout: timeoutMs, polling: 200 }
    );
    const bots = await this.getBots();
    const bot = bots.find((b) => b.id === botId);
    if (!bot) {
      throw new Error(`Bot ${botId} missing after respawn`);
    }
    return { x: bot.x, y: bot.y };
  }

  async dieOnceViaBoundary(): Promise<{ x: number; y: number }> {
    await this.waitForCombatReady();
    const livesBefore = await this.getLives();
    await this.observeNextDeathCause();
    const loot = await this.getLoot();
    const rotation = Math.max(0, 3 - livesBefore) * ((Math.PI * 2) / 3);
    const deathPosition = Array.from({ length: 24 }, (_, index) => {
      const angle = rotation + (index * Math.PI * 2) / 24;
      const point = { x: 3150 * Math.cos(angle), y: 3150 * Math.sin(angle) };
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
      // A final boundary death disconnects before another motion acknowledgement
      // can arrive. Finish fixture placement inside the arena, then cross the
      // wall through the real client collision path.
      await this.placeShipAt((deathPosition.x * 3000) / 3150, (deathPosition.y * 3000) / 3150);
      await this.setPredictedShipPosition(deathPosition.x, deathPosition.y);
      // Observe enough collision frames for a ship whose collected mass raised
      // its health above the base 100, including the final game-over transition.
      await this.waitForAnimationFrames(4);
      await this.page.waitForTimeout(100);
      if ((await this.getLives()) < livesBefore) {
        await this.requireObservedDeathCause('boundary');
        if ((await this.getLives()) > 0 && (await this.isGameRunning())) {
          await this.waitForShipRespawn(deathPosition, 25000);
        }
        return { x: deathPosition.x, y: deathPosition.y };
      }
    }
    throw new Error('boundary crossing should cost a life');
  }

  /** Burn through all lives until the game-over flow stops the session. */
  async dieUntilGameOver(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lives = await this.getLives();
      if (lives <= 0 || !(await this.isGameRunning())) {
        break;
      }
      await this.dieOnceViaBoundary();
      if ((await this.getLives()) > 0 && (await this.isGameRunning())) {
        await this.waitForShipAlive(25000);
        await this.waitForCombatReady();
      }
    }
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
  async fireLaserAtRemotePlayer(targetPlayerId: string): Promise<void> {
    const firingPoint = await this.page.evaluate((targetId) => {
      const gc = window.gameController;
      const players = gc?.getNetworkManager().getAllPlayers() ?? [];
      const target = players.find((p) => p.id === targetId);
      const local = gc?.getPlayerManager()?.getLocalPlayer?.();
      const ship = gc?.getPlayerManager()?.getLocalPlayer?.()?.ship;
      if (!target?.ship || !ship) {
        throw new Error('Shooter or target ship unavailable');
      }
      const localFaction = local?.factionId ?? ship.factionId;
      const targetFaction = target.factionId ?? target.ship.factionId;
      if (!localFaction || !targetFaction || localFaction === targetFaction) {
        throw new Error('Remote laser target must belong to the opposing faction');
      }
      const tx = target.ship.position.x;
      const ty = target.ship.position.y;
      return { x: tx - 45, y: ty };
    }, targetPlayerId);
    await this.placeShipAt(firingPoint.x, firingPoint.y);
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
    await this.page.waitForTimeout(300);
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

  async pinShipOnSatellitePickup(pickupId: string, durationMs = 2000): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const position = await this.page.evaluate((id) => {
        const pickup = window.gameController?.getSatellitePickups().find((item) => item.id === id);
        return pickup ? { x: pickup.position.x, y: pickup.position.y } : null;
      }, pickupId);
      if (!position) {
        return;
      }
      await this.placeShipAt(position.x, position.y);
      await this.page.waitForTimeout(100);
    }
  }

  /** Standard one-client boot against the multiplayer server. */
  async bootGame(options?: {
    waitForCombatReady?: boolean;
    kitId?: 'dart' | 'hauler' | 'warden' | 'skirmisher' | 'quake';
  }): Promise<void> {
    await this.navigateToGame();
    if (options?.kitId) {
      const kitButton = this.page.locator(`[data-kit-id="${options.kitId}"]`);
      await kitButton.waitFor({ state: 'visible', timeout: 5000 });
      await kitButton.click();
    }
    await this.startGame();
    await this.waitForGameReady();
    await this.waitForServerJoin();
    await this.waitForNetworkAsteroids(1);
    if (options?.waitForCombatReady !== false) {
      await this.waitForCombatReady();
    }
  }

  /** Alias used by satellite-pickup scenario tests. */
  async bootSinglePlayerGame(options?: {
    waitForCombatReady?: boolean;
    kitId?: 'dart' | 'hauler' | 'warden' | 'skirmisher' | 'quake';
  }): Promise<void> {
    await this.bootGame(options);
  }
}
