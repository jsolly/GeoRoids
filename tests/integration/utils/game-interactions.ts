import type { Page } from 'playwright';
import { describeDeathCause } from '../../../src/utils/deathCause';
import { TestConfig, TestSelectors } from './test-config';
import { TestServerControl } from './test-server-control';

export class GameInteractions {
  constructor(private page: Page) {}

  /**
   * Navigate to the game
   */
  async navigateToGame(): Promise<void> {
    console.log('🌐 Navigating to game...');

    // Add console error logging
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log('🚨 Browser console error during navigation:', msg.text());
      }
    });

    // Add page error logging
    this.page.on('pageerror', (error) => {
      console.log('🚨 Page error during navigation:', error.message);
    });

    try {
      await this.page.goto(TestConfig.GAME_URL, {
        waitUntil: 'load',
        timeout: 30000,
      });
      console.log('✅ Navigated to game');
    } catch (error) {
      console.log('❌ Navigation failed:', error);
      throw error;
    }
  }

  /**
   * Wait for and click the start game button
   */
  async startGame(): Promise<void> {
    // Check for console errors first
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log('🚨 Browser console error:', msg.text());
      }
    });

    // Wait for the start screen to load and be visible
    await this.page.waitForSelector('#start-screen', { timeout: 5000 });

    // Check if start screen is visible with more detailed logging
    await this.page.waitForFunction(
      () => {
        const startScreen = document.querySelector('#start-screen');
        if (!startScreen) {
          console.log('🔍 Start screen element not found');
          return false;
        }

        const computedStyle = window.getComputedStyle(startScreen);
        const rect = (startScreen as HTMLElement).getBoundingClientRect();

        // Check visibility using multiple methods
        const isVisible =
          computedStyle.display !== 'none' &&
          computedStyle.visibility !== 'hidden' &&
          computedStyle.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0;

        console.log('🔍 Start screen visibility check:', {
          element: !!startScreen,
          display: computedStyle.display,
          visibility: computedStyle.visibility,
          opacity: computedStyle.opacity,
          rect: { width: rect.width, height: rect.height },
          isVisible,
        });

        return isVisible;
      },
      undefined,
      { timeout: 10000 }
    );
    console.log('✅ Start screen loaded');

    // Find and click the play button
    const playButton = await this.page.locator('#start-game');
    await this.page.waitForFunction(() => {
      const button = document.querySelector('#start-game');
      if (!button) {
        return false;
      }

      const computedStyle = window.getComputedStyle(button);
      const rect = (button as HTMLElement).getBoundingClientRect();

      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        computedStyle.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    console.log('🎮 Clicking play button...');
    await playButton.click();
    console.log('✅ Play button clicked');

    // Wait for game area to appear and be visible
    await this.page.waitForSelector('#gameArea', { timeout: 5000 });
    await this.page.waitForFunction(
      () => {
        const gameArea = document.querySelector('#gameArea');
        if (!gameArea) {
          return false;
        }

        const computedStyle = window.getComputedStyle(gameArea);
        const rect = (gameArea as HTMLElement).getBoundingClientRect();

        return (
          computedStyle.display !== 'none' &&
          computedStyle.visibility !== 'hidden' &&
          computedStyle.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
      undefined,
      { timeout: 5000 }
    );
    console.log('✅ Game area loaded');
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

        const localPlayer = gameController.getPlayerManager()?.getLocalPlayer?.();
        const networkManager = gameController.getNetworkManager?.();
        return Boolean(localPlayer && networkManager?.isConnected);
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );
    console.log('⏳ Game initialization complete');
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
      const rect = (canvas as HTMLElement).getBoundingClientRect();

      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        computedStyle.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    console.log('✅ Game canvas visible');
  }

  /**
   * Fire lasers multiple times using mouse clicks (left mouse button)
   */
  async fireLasersWithMouse(count: number, delayMs: number = 500): Promise<void> {
    console.log(`🔫 Firing ${count} times with mouse clicks...`);
    const canvas = this.page.locator(TestSelectors.GAME_CANVAS);
    await canvas.waitFor({ state: 'visible', timeout: 5000 });

    for (let i = 1; i <= count; i++) {
      console.log(`  Mouse firing ${i}/${count}...`);
      const box = await canvas.boundingBox();
      if (!box) {
        throw new Error('Canvas bounding box unavailable for mouse fire');
      }
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.page.mouse.move(x, y);
      await this.page.mouse.down({ button: 'left' });
      await this.runGameFrames(10);
      await this.page.mouse.up({ button: 'left' });
      await this.runGameFrames(5);
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
          const ship = window.gameController?.getPlayerManager().getLocalPlayer()?.ship;
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

  /**
   * Move the ship in a specified direction
   */
  async moveShip(
    direction: 'left' | 'right' | 'up' | 'down',
    durationMs: number = 1000
  ): Promise<void> {
    console.log(`🚀 Moving ship ${direction} for ${durationMs}ms...`);
    // Headless Chromium may not run requestAnimationFrame during Playwright timeouts.
    // Drive the real game loop while thrust/turn are active (same physics as keybindings).
    await this.page.evaluate(
      async ({ moveDirection, holdMs }) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
        if (!gc?.updateGame || !ship) {
          throw new Error('Local ship or gameController.updateGame is not available');
        }
        const turnSpeedRadPerFrame = (450 * Math.PI) / (180 * 60);
        if (moveDirection === 'left') {
          ship.angularVelocity = turnSpeedRadPerFrame;
        } else if (moveDirection === 'right') {
          ship.angularVelocity = -turnSpeedRadPerFrame;
        } else {
          ship.thrusting = true;
        }
        const deadline = performance.now() + holdMs;
        while (performance.now() < deadline) {
          gc.updateGame();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        ship.thrusting = false;
        ship.angularVelocity = 0;
        gc.updateGame();
      },
      { moveDirection: direction, holdMs: durationMs }
    );
    console.log(`✅ Ship movement complete`);
  }

  /** Advance the client game loop for a number of frames (headless-safe). */
  async runGameFrames(frameCount: number): Promise<void> {
    await this.page.evaluate(async (frames) => {
      const gc = window.gameController;
      if (!gc?.updateGame) {
        throw new Error('gameController.updateGame is not available');
      }
      for (let i = 0; i < frames; i++) {
        gc.updateGame();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, frameCount);
  }

  /** Wait until the server reports spawn protection on the local player. */
  async waitForServerSpawnProtection(timeoutMs: number = 15000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const lp = gc.getPlayerManager().getLocalPlayer();
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
      const rect = (gameArea as HTMLElement).getBoundingClientRect();

      return (
        computedStyle.display !== 'none' &&
        computedStyle.visibility !== 'hidden' &&
        computedStyle.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    console.log('✅ Game area verified');
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
      () => {
        const gameController = window.gameController;
        if (!gameController) {
          return false;
        }
        return gameController?.getGameStateManager()?.getIsGameRunning?.() === true;
      },
      undefined,
      { timeout: 10000 }
    );
    console.log('✅ Game ready');
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
        const actualCount = gameController.getCurrRoidBelt().getRoids().length;
        console.log(`🔍 Checking asteroids: expected >= ${expectedCount}, actual = ${actualCount}`);
        return actualCount >= expectedCount;
      },
      count,
      { timeout: timeoutMs }
    );
    console.log(`✅ Waited for ${count} asteroids`);
  }

  /**
   * Get the current asteroid count
   */
  async getAsteroidCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
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
        throw new Error('Game controller is unavailable');
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
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.mass;
    });
  }

  async getShipRadius(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.r;
    });
  }

  async getShipMaxHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.maxHealth;
    });
  }

  /**
   * Get ship health
   */
  async getShipHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.health;
    });
  }

  /**
   * Get ship position
   */
  async getShipPosition(): Promise<{ x: number; y: number }> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.position;
    });
  }

  /** Logical viewport dimensions used by world projection and culling. */
  async getCanvasSize(): Promise<{ width: number; height: number }> {
    return await this.page.evaluate(() => {
      const canvas = document.getElementById('gameCanvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Game canvas is unavailable');
      }
      const { width, height } = canvas.getBoundingClientRect();
      return { width, height };
    });
  }

  /** Get asteroid positions; Roid exposes its radius as `r`. */
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
        throw new Error('Game controller is unavailable');
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
   * Check if the ship is currently exploding
   */
  async isShipExploding(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gameController = window.gameController;
      if (!gameController) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gameController.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
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
        throw new Error('Game controller is unavailable');
      }
      const nm = gc.getNetworkManager();
      const localId = nm?.getLocalPlayerId?.();
      const fromNetwork = localId ? nm?.getPlayer?.(localId) : undefined;
      const local = gc.getPlayerManager().getLocalPlayer();
      const player = fromNetwork ?? local;
      if (!player) {
        throw new Error('Local player is unavailable');
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
        throw new Error('Game controller is unavailable');
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
        throw new Error('Game controller is unavailable');
      }
      const player = gc.getPlayerManager().getLocalPlayer();
      if (!player) {
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
    const placement = await TestServerControl.placePlayer(playerId, { x, y });
    await this.waitForFixtureMotionEpoch(placement.motionEpoch);
    await this.setPredictedShipPosition(x, y, { clearSpawnProtection: true });
  }

  private async waitForFixtureMotionEpoch(motionEpoch: number | undefined): Promise<void> {
    if (motionEpoch === undefined) {
      return;
    }
    await this.page.waitForFunction(
      (expectedEpoch) => {
        const ship = window.gameController?.getPlayerManager().getLocalPlayer()?.ship;
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
        const ship = window.gameController?.getPlayerManager().getLocalPlayer()?.ship;
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
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
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
        throw new Error('Game controller is unavailable');
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
        laserCount: sat.lasers.length,
      }));
    });
  }

  /** Wait until at least `count` satellites are known to the client. */
  async waitForSatellites(count: number, timeoutMs = 25000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        return gc.getSatellites().length >= expected;
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
          throw new Error('Game controller is unavailable');
        }
        const sat = gc.getSatellites().find((s) => s.id === id);
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
        if (!sat || !ship) {
          return null;
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
            throw new Error('Game controller is unavailable');
          }
          const sat = gc.getSatellites().find((s) => s.id === id);
          const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
          if (!sat || !ship || sat.health <= 0 || sat.exploding) {
            return;
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
          throw new Error('Game controller is unavailable');
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
      throw new Error(`Satellite ${satelliteId} was not observed while attacking`);
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
          throw new Error('Game controller is unavailable');
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
        throw new Error('Game controller is unavailable');
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
        if (!gc) {
          return false;
        }
        const local = gc.getPlayerManager().getLocalPlayer();
        const localFaction = local?.factionId ?? local?.ship?.factionId;
        if (!localFaction) {
          return false;
        }
        const players = gc.getNetworkManager().getAllPlayers();
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
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const local = gc.getPlayerManager().getLocalPlayer();
      const localFaction = local?.factionId ?? local?.ship?.factionId;
      const players = gc.getNetworkManager().getAllPlayers();
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

  /** Wait for a bot's real laser shield to expire before the next shot. */
  async waitForBotShieldToClear(botId: string, timeoutMs = 15000): Promise<void> {
    await this.page.waitForFunction(
      (id) => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const players = gc.getNetworkManager().getAllPlayers();
        const bot = players.find((player) => player.id === id);
        return !bot || (!bot.ship?.shieldActive && (bot.ship?.shieldTime ?? 0) <= 0);
      },
      botId,
      { timeout: timeoutMs, polling: 100 }
    );
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
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
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
    await this.runGameFrames(5);
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
          throw new Error('Game controller is unavailable');
        }
        const roids = gc.getCurrRoidBelt().getRoids();
        return !roids.some((r) => r.id === id);
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
            throw new Error('Game controller is unavailable');
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
          throw new Error('Game controller is unavailable');
        }
        const roids = gc.getCurrRoidBelt().getRoids();
        const target = roids.find((roid) => roid.id === id);
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
        await this.runGameFrames(1);
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
        await this.runGameFrames(1);
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
  ): Promise<{ minHealthObserved: number; everExploding: boolean; scoreGain: number }> {
    const startScore = await this.getScore();
    const playerId = await this.getLocalPlayerId();
    const retreat = { x: -1800, y: -1800 };
    let minHealthObserved = Number.POSITIVE_INFINITY;
    let everExploding = false;
    let fired = 0;

    while (fired < shots) {
      await this.waitForBotShieldToClear(botId);
      const arrangement = await TestServerControl.arrangeBotShot(playerId, botId);
      await this.waitForFixtureMotionEpoch(arrangement.motionEpoch);
      await this.setPredictedShipPosition(
        arrangement.playerPosition.x,
        arrangement.playerPosition.y
      );
      const sample = await this.page.waitForFunction(
        ({ id, expectedHealth, expectedPosition }) => {
          const gc = window.gameController;
          if (!gc) {
            return false;
          }
          const players = gc.getNetworkManager().getAllPlayers();
          const bot = players.find((player) => player.id === id);
          if (!bot?.ship) {
            return false;
          }
          if (
            bot.ship.health !== expectedHealth ||
            bot.ship.exploding ||
            Math.hypot(
              bot.ship.position.x - expectedPosition.x,
              bot.ship.position.y - expectedPosition.y
            ) > 20
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
          const gc = window.gameController;
          if (!gc) {
            throw new Error('Game controller is unavailable');
          }
          const players = gc.getNetworkManager().getAllPlayers();
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
    const endScore = await this.getScore();
    return {
      minHealthObserved,
      everExploding,
      scoreGain: endScore - startScore,
    };
  }

  /** Wait until the local player is registered on the server (post-join). */
  async waitForServerJoin(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        await this.page.waitForFunction(
          () => {
            const gc = window.gameController;
            if (!gc) {
              return false;
            }
            const nm = gc.getNetworkManager();
            if (!nm?.isConnected) {
              return false;
            }
            const id = nm.getLocalPlayerId?.();
            const lp = gc.getPlayerManager().getLocalPlayer();
            return Boolean(id && lp);
          },
          undefined,
          { timeout: Math.min(5000, remaining), polling: 200 }
        );
        return;
      } catch {
        await this.page
          .evaluate(async () => {
            const gc = window.gameController;
            if (!gc) {
              throw new Error('Game controller is unavailable');
            }
            const nm = gc.getNetworkManager();
            if (!nm || nm.isConnected) {
              return;
            }
            await nm.connect();
            nm.initializeAsteroidSync?.();
          })
          .catch((error: unknown) => {
            console.error('Server-join retry failed', error);
          });
      }
    }
    throw new Error(`Timed out waiting for server join after ${timeoutMs}ms`);
  }

  async waitForCombatReady(timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.page.evaluate(() => {
        const player = window.gameController?.getPlayerManager().getLocalPlayer();
        const ship = player?.ship;
        if (!ship) {
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
      await this.runGameFrames(3);
    }
    throw new Error(`Timed out waiting for combat readiness after ${timeoutMs}ms`);
  }

  /** Wait until the local client has at least one synced asteroid. */
  async waitForNetworkAsteroids(minCount = 1, timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const readReadyCount = () =>
      this.page.evaluate(() => window.gameController?.getCurrRoidBelt().getRoids().length);

    while (Date.now() < deadline) {
      const clientCount = await readReadyCount();
      if (clientCount === undefined) {
        await this.page.waitForTimeout(200);
        continue;
      }
      if (clientCount >= minCount) {
        return;
      }

      const world = await TestServerControl.getWorldDiagnostics();
      if (world && world.asteroids >= minCount) {
        await this.runGameFrames(5);
      } else {
        await this.page.waitForTimeout(200);
      }
    }

    const clientCount = await readReadyCount();
    const world = await TestServerControl.getWorldDiagnostics();
    throw new Error(
      `Timed out waiting for ${minCount} synced asteroid(s): client=${clientCount ?? 'unavailable'}, server=${world?.asteroids ?? 'unknown'}`
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
            throw new Error('Game controller is unavailable');
          }
          const players = gc.getNetworkManager().getAllPlayers();
          const satellites = gc.getSatellites();
          return [
            ...players
              .filter((player) => player.ship?.health > 0 && !player.ship.exploding)
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
        await this.runGameFrames(3);
        continue;
      }
      usedAsteroids.add(target.id);
      lastImpact = { x: target.x, y: target.y };
      await this.placeShipAt(target.x, target.y);
      await this.runGameFrames(5);
      await this.page.waitForTimeout(100);

      if ((await this.getLives()) < startLives) {
        // Move off the impact point so split fragments cannot re-damage the
        // ship while we wait for the server respawn reposition.
        await this.page.evaluate(({ x, y }) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('Game controller is unavailable');
          }
          const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
          if (!ship) {
            return;
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
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
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
        const ship = window.gameController?.getPlayerManager()?.getLocalPlayer()?.ship;
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
      await this.runGameFrames(20);
      const placement = await this.page.evaluate(
        ({ deathPosition, minDistance }) => {
          const gc = window.gameController;
          if (!gc) {
            throw new Error('Game controller is unavailable');
          }
          const player = gc.getPlayerManager().getLocalPlayer();
          const ship = player?.ship;
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
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const player = gc.getPlayerManager().getLocalPlayer();
        const ship = player?.ship;
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

  /** Whether the main game loop is still running. */
  async isGameRunning(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      return gc.getIsGameRunning();
    });
  }

  /** Whether the latest complete server snapshot still grants protection. */
  async isServerSpawnProtected(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const player = gc.getPlayerManager().getLocalPlayer();
      if (!player) {
        throw new Error('Local player is unavailable');
      }
      return player.serverSpawnProtectionTimer > 0;
    });
  }

  /** HUD overlay text (game over, death messages). */
  async getHudText(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
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
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.lasers.length;
    });
  }

  /** Local ship heading in radians. */
  async getShipAngle(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = window.gameController;
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
      if (!ship) {
        throw new Error('Local ship is unavailable');
      }
      return ship.angle;
    });
  }

  /** Wait until at least `minCount` remote human players are visible. */
  async waitForRemoteHumanPlayers(minCount = 1, timeoutMs = 20000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const localId = gc.getNetworkManager().getLocalPlayerId();
        const remotes = gc
          .getNetworkManager()
          .getAllPlayers()
          .filter((p) => p.type === 'remote' && p.id !== localId);
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
        throw new Error('Game controller is unavailable');
      }
      const localId = gc.getNetworkManager().getLocalPlayerId();
      return gc
        .getNetworkManager()
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
        throw new Error('Game controller is unavailable');
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
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const players = gc.getNetworkManager().getAllPlayers();
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
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const players = gc.getNetworkManager().getAllPlayers();
        const bot = players.find((p) => p.id === id);
        return Boolean(
          bot?.ship &&
            bot.ship.health > 0 &&
            bot.ship.health === bot.ship.maxHealth &&
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
      await this.placeShipAt(deathPosition.x, deathPosition.y);
      // Playwright timeouts do not reliably advance requestAnimationFrame in
      // headless Chromium. Drive enough real collision frames to kill even a
      // ship whose collected mass raised its health above the base 100.
      await this.runGameFrames(4);
      await this.page.waitForTimeout(100);
      if ((await this.getLives()) < livesBefore) {
        await this.requireObservedDeathCause('boundary');
        if ((await this.getLives()) > 0 && (await this.isGameRunning())) {
          await this.waitForRandomRespawnPlacement(deathPosition, 25000);
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
        const gc = window.gameController;
        if (!gc) {
          return false;
        }
        const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
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
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const players = gc.getNetworkManager().getAllPlayers();
      const target = players.find((p) => p.id === targetId);
      const local = gc.getPlayerManager().getLocalPlayer();
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
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
      if (!gc) {
        throw new Error('Game controller is unavailable');
      }
      const players = gc.getNetworkManager().getAllPlayers();
      const target = players.find((p) => p.id === targetId);
      const ship = gc.getPlayerManager().getLocalPlayer()?.ship;
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
        throw new Error('Game controller is unavailable');
      }
      const local = gc.getPlayerManager().getLocalPlayer();
      if (local?.id === id) {
        return local.ship.health;
      }
      const players = gc.getNetworkManager().getAllPlayers();
      const found = players.find((p) => p.id === id);
      if (!found) {
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
        throw new Error('Game controller is unavailable');
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
        if (!gc) {
          return false;
        }
        return gc.getSatellitePickups().length >= expected;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  async pinShipOnSatellitePickup(pickupId: string, durationMs = 2000): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const position = await this.page.evaluate((id) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller is unavailable');
        }
        const pickup = gc.getSatellitePickups().find((item) => item.id === id);
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
