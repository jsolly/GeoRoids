import { Page } from 'playwright';
import { TestConfig, TestSelectors } from './test-config';
import { TestServerControl } from './test-server-control';
import { ServerLogHelper } from './server-log-helper';

export class GameInteractions {
  constructor(private page: Page) {}

  /**
   * Navigate to the game
   */
  async navigateToGame(): Promise<void> {
    console.log('🌐 Navigating to game...');
    
    // Add console error logging
    this.page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('🚨 Browser console error during navigation:', msg.text());
      }
    });

    // Add page error logging
    this.page.on('pageerror', error => {
      console.log('🚨 Page error during navigation:', error.message);
    });

    try {
      await this.page.goto(TestConfig.GAME_URL, {
        waitUntil: 'load',
        timeout: 30000 
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
    this.page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log('🚨 Browser console error:', msg.text());
      }
    });

    // Wait for the start screen to load and be visible
    await this.page.waitForSelector('#start-screen', { timeout: 5000 });
    
    // Check if start screen is visible with more detailed logging
    await this.page.waitForFunction(() => {
      const startScreen = document.querySelector('#start-screen');
      if (!startScreen) {
        console.log('🔍 Start screen element not found');
        return false;
      }
      
      const computedStyle = window.getComputedStyle(startScreen);
      const rect = (startScreen as HTMLElement).getBoundingClientRect();
      
      // Check visibility using multiple methods
      const isVisible = computedStyle.display !== 'none' && 
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
        isVisible
      });
      
      return isVisible;
    }, { timeout: 10000 });
    console.log('✅ Start screen loaded');

    // Find and click the play button
    const playButton = await this.page.locator('#start-game');
    await this.page.waitForFunction(() => {
      const button = document.querySelector('#start-game');
      if (!button) return false;
      
      const computedStyle = window.getComputedStyle(button);
      const rect = (button as HTMLElement).getBoundingClientRect();
      
      return computedStyle.display !== 'none' && 
             computedStyle.visibility !== 'hidden' && 
             computedStyle.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    });
    console.log('🎮 Clicking play button...');
    await playButton.click();
    console.log('✅ Play button clicked');

    // Wait for game area to appear and be visible
    await this.page.waitForSelector('#gameArea', { timeout: 5000 });
    await this.page.waitForFunction(() => {
      const gameArea = document.querySelector('#gameArea');
      if (!gameArea) return false;
      
      const computedStyle = window.getComputedStyle(gameArea);
      const rect = (gameArea as HTMLElement).getBoundingClientRect();
      
      return computedStyle.display !== 'none' && 
             computedStyle.visibility !== 'hidden' && 
             computedStyle.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    }, { timeout: 5000 });
    console.log('✅ Game area loaded');
  }

  /**
   * Wait for the game to be fully initialized
   */
  async waitForGameInitialization(timeoutMs: number = TestConfig.GAME_INIT_TIMEOUT): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const gameController = (window as any).gameController;
        if (!gameController) {
          return false;
        }

        const gameArea = document.querySelector('#gameArea');
        const canvas = document.querySelector('#gameCanvas');
        if (!gameArea || !canvas) {
          return false;
        }

        const localPlayer = gameController.playerManager?.getLocalPlayer?.();
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
      if (!canvas) return false;
      
      const computedStyle = window.getComputedStyle(canvas);
      const rect = (canvas as HTMLElement).getBoundingClientRect();
      
      return computedStyle.display !== 'none' && 
             computedStyle.visibility !== 'hidden' && 
             computedStyle.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    });
    console.log('✅ Game canvas visible');
  }

  /**
   * Fire lasers multiple times using space key (legacy method)
   */
  async fireLasers(count: number, delayMs: number = 500): Promise<void> {
    console.log(`🔫 Firing ${count} times with space key...`);
    for (let i = 1; i <= count; i++) {
      console.log(`  Firing ${i}/${count}...`);
      await this.page.keyboard.press(' ');
      if (i < count) {
        await this.page.waitForTimeout(delayMs);
      }
    }
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
    await this.page.waitForFunction(
      (expectedHealth) => {
        const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
        return ship?.health === expectedHealth;
      },
      expected,
      { timeout: timeoutMs, polling: 100 }
    ).catch(async () => {
      throw new Error(`Timed out waiting for ship health ${expected} (got ${await this.getShipHealth()})`);
    });
  }

  /**
   * Move the ship in a specified direction
   */
  async moveShip(direction: 'left' | 'right' | 'up' | 'down', durationMs: number = 1000): Promise<void> {
    console.log(`🚀 Moving ship ${direction} for ${durationMs}ms...`);
    // Headless Chromium may not run requestAnimationFrame during Playwright timeouts.
    // Drive the real game loop while thrust/turn are active (same physics as keybindings).
    await this.page.evaluate(
      async ({ moveDirection, holdMs }) => {
        const gc = (window as any).gameController;
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
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
      const gc = (window as any).gameController;
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
        const gc = (window as any).gameController;
        const lp = gc?.playerManager?.getLocalPlayer?.();
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
      if (!gameArea) return false;
      
      const computedStyle = window.getComputedStyle(gameArea);
      const rect = (gameArea as HTMLElement).getBoundingClientRect();
      
      return computedStyle.display !== 'none' && 
             computedStyle.visibility !== 'hidden' && 
             computedStyle.opacity !== '0' &&
             rect.width > 0 && 
             rect.height > 0;
    });
    console.log('✅ Game area verified');
  }

  /**
   * Get page text content for debugging
   */
  async getPageTextContent(maxLength: number = 500): Promise<string> {
    const pageText = await this.page.textContent('body');
    const truncated = pageText?.substring(0, maxLength) + '...';
    console.log('📄 Page text content:', truncated);
    return pageText || '';
  }

  /**
   * Check for debug information on the page
   */
  async checkForDebugInfo(): Promise<{ found: boolean; details: string[] }> {
    const debugSelectors = [
      'text=Asteroids:',
      'text=DEBUG MODE',
      '[id*="debug"]',
      '[class*="debug"]'
    ];

    const details: string[] = [];
    let found = false;

    for (const selector of debugSelectors) {
      try {
        const element = await this.page.locator(selector).first();
        if (await element.isVisible()) {
          details.push(`✅ Found debug info with selector: ${selector}`);
          found = true;
          break;
        }
      } catch (e) {
        details.push(`❌ Selector failed: ${selector}`);
      }
    }

    if (!found) {
      details.push('⚠️ No debug info found with any selector');
      
      // Check for elements containing specific text
      const elementsWithAsteroid = await this.page.locator('*:has-text("Asteroid")').count();
      details.push(`🔍 Elements containing "Asteroid": ${elementsWithAsteroid}`);
      
      const elementsWithDebug = await this.page.locator('*:has-text("DEBUG")').count();
      details.push(`🔍 Elements containing "DEBUG": ${elementsWithDebug}`);
    }

    return { found, details };
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
        const gameController = (window as any).gameController;
        return gameController?.gameStateManager?.getIsGameRunning?.() === true;
      },
      { timeout: 10000 }
    );
    console.log('✅ Game ready');
  }

  /**
   * Enable debug settings for testing
   */
  async enableDebugSettings(settings: Record<string, any>): Promise<void> {
    await this.page.evaluate((settings) => {
      const gameController = (window as any).gameController;
      if (gameController?.debugManager) {
        // Apply debug settings to the game controller
        Object.assign(gameController.debugManager, settings);
        console.log('🔧 Debug settings applied:', settings);
      } else {
        console.log('🔧 Debug settings enabled (no debug manager):', settings);
      }
    }, settings);
  }

  /**
   * Wait for a specific number of asteroids to be created
   */
  async waitForAsteroids(count: number, timeoutMs: number = 20000): Promise<void> {
    await this.page.waitForFunction(
      (expectedCount) => {
        const gameController = (window as any).gameController;
        if (gameController?.getCurrRoidBelt) {
          const roidBelt = gameController.getCurrRoidBelt();
          const actualCount = roidBelt ? roidBelt.getRoids().length : 0;
          console.log(`🔍 Checking asteroids: expected >= ${expectedCount}, actual = ${actualCount}`);
          return actualCount >= expectedCount;
        }
        console.log(`🔍 No game controller or roid belt available`);
        return false;
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
      const gameController = (window as any).gameController;
      if (gameController?.getCurrRoidBelt) {
        const roidBelt = gameController.getCurrRoidBelt();
        return roidBelt ? roidBelt.getRoids().length : 0;
      }
      return 0;
    });
  }

  async getLoot(): Promise<
    Array<{ id: string; x: number; y: number; mass: number; radius: number; kind: string }>
  > {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      const loot = gameController?.getLoot?.() ?? [];
      return loot.map(
        (drop: {
          id: string;
          position: { x: number; y: number };
          mass: number;
          radius: number;
          kind?: string;
        }) => ({
          id: drop.id,
          x: drop.position.x,
          y: drop.position.y,
          mass: drop.mass,
          radius: drop.radius,
          kind: drop.kind ?? 'wreckage',
        })
      );
    });
  }

  async getShipMass(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      return gameController?.playerManager?.getLocalPlayer?.()?.ship?.mass ?? 1;
    });
  }

  async getShipRadius(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      return gameController?.playerManager?.getLocalPlayer?.()?.ship?.r ?? 15;
    });
  }

  async getShipMaxHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      return gameController?.playerManager?.getLocalPlayer?.()?.ship?.maxHealth ?? 100;
    });
  }

  /**
   * Get asteroid sizes
   */
  async getAsteroidSizes(): Promise<number[]> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.getCurrRoidBelt) {
        const roidBelt = gameController.getCurrRoidBelt();
        return roidBelt ? roidBelt.getRoids().map((roid: any) => roid.r) : [];
      }
      return [];
    });
  }

  /**
   * Move ship to collide with asteroids
   */
  async moveShipToAsteroids(): Promise<void> {
    // Move ship around to increase collision chances
    // Move in a pattern that covers more area
    await this.moveShip('up', 1000);
    await this.moveShip('down', 1000);
    await this.moveShip('left', 1000);
    await this.moveShip('right', 1000);
    await this.moveShip('up', 1000);
    await this.moveShip('down', 1000);
  }

  /**
   * Wait for asteroid splitting to occur
   */
  async waitForAsteroidSplitting(timeoutMs: number = 3000): Promise<void> {
    await this.page.waitForTimeout(timeoutMs);
    console.log('✅ Waited for asteroid splitting');
  }

  /**
   * Wait for asteroid destruction
   */
  async waitForAsteroidDestruction(timeoutMs: number = 2000): Promise<void> {
    await this.page.waitForTimeout(timeoutMs);
    console.log('✅ Waited for asteroid destruction');
  }

  /**
   * Get ship health
   */
  async getShipHealth(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.playerManager?.getLocalPlayer) {
        const player = gameController.playerManager.getLocalPlayer();
        // Use ?? (not ||) so a real health of 0 isn't reported as full health.
        return player?.ship?.health ?? 100;
      }
      return 100;
    });
  }

  /**
   * Get ship position
   */
  async getShipPosition(): Promise<{ x: number; y: number }> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.playerManager?.getLocalPlayer) {
        const player = gameController.playerManager.getLocalPlayer();
        const pos = player?.ship?.position;
        if (pos) return pos;
      }
      throw new Error('No local ship position available');
    });
  }

  /**
   * Get asteroid positions. (Roid exposes its radius as `r`, not `radius`.)
   */
  async getCanvasSize(): Promise<{ width: number; height: number }> {
    return await this.page.evaluate(() => {
      const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;
      return {
        width: canvas?.width || 800,
        height: canvas?.height || 600,
      };
    });
  }

  async getAsteroidPositions(): Promise<
    Array<{ x: number; y: number; radius: number; id: string; isCollabTarget?: boolean; material?: string }>
  > {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.getCurrRoidBelt) {
        const roidBelt = gameController.getCurrRoidBelt();
        return roidBelt ? roidBelt.getRoids().map((roid: any) => ({
          x: roid.position.x,
          y: roid.position.y,
          radius: roid.r,
          id: roid.id,
          isCollabTarget: roid.isCollabTarget === true,
          material: roid.material,
        })) : [];
      }
      return [];
    });
  }

  /**
   * Get detailed asteroid information
   */
  async getAsteroidDetails(): Promise<Array<{ x: number; y: number; radius: number; size: number; id: string }>> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.getCurrRoidBelt) {
        const roidBelt = gameController.getCurrRoidBelt();
        return roidBelt ? roidBelt.getRoids().map((roid: any) => ({
          x: roid.position.x,
          y: roid.position.y,
          radius: roid.r,
          size: roid.r,
          id: roid.id || 'unknown'
        })) : [];
      }
      return [];
    });
  }

  /**
   * Wait for a specified amount of time
   */
  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /**
   * Get player score
   */
  async getPlayerScore(): Promise<number> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.getCurrScore) {
        return gameController.getCurrScore();
      }
      return 0;
    });
  }

  /**
   * Create medium roids for testing
   */
  async createMediumRoids(count: number): Promise<void> {
    console.log(`🔧 Creating ${count} medium roids`);
    // This would need to interact with the game to create roids
  }

  /**
   * Create small roids for testing
   */
  async createSmallRoids(count: number): Promise<void> {
    console.log(`🔧 Creating ${count} small roids`);
    // This would need to interact with the game to create roids
  }

  /**
   * Move ship to a specific position
   */
  async moveShipToPosition(x: number, y: number): Promise<void> {
    console.log(`🚀 Moving ship to position (${x}, ${y})...`);
    
    // Get current ship position
    const currentPos = await this.getShipPosition();
    if (!currentPos) {
      console.log('❌ Could not get current ship position');
      return;
    }
    
    console.log(`🔍 Current ship position: (${currentPos.x}, ${currentPos.y})`);
    
    // Calculate movement needed
    const deltaX = x - currentPos.x;
    const deltaY = y - currentPos.y;
    
    console.log(`🔍 Movement needed: deltaX=${deltaX}, deltaY=${deltaY}`);
    
    // Move in the required direction with more aggressive movement to ensure collision
    if (deltaX > 0) {
      await this.moveShip('right', Math.max(1000, Math.abs(deltaX) / 2)); // Ensure at least 1 second of movement
    } else if (deltaX < 0) {
      await this.moveShip('left', Math.max(1000, Math.abs(deltaX) / 2));
    }
    
    if (deltaY > 0) {
      await this.moveShip('down', Math.max(1000, Math.abs(deltaY) / 2));
    } else if (deltaY < 0) {
      await this.moveShip('up', Math.max(1000, Math.abs(deltaY) / 2));
    }
    
    console.log(`✅ Ship movement to (${x}, ${y}) complete`);
  }

  /**
   * Move ship in a pattern to collide with multiple roids
   */
  async moveShipInPattern(): Promise<void> {
    const movements = ['up', 'right', 'down', 'left'] as const;
    for (const direction of movements) {
      await this.moveShip(direction, 300);
    }
  }

  /**
   * Wait for multiple collisions
   */
  async waitForMultipleCollisions(timeoutMs: number = 5000): Promise<void> {
    await this.page.waitForTimeout(timeoutMs);
    console.log('✅ Waited for multiple collisions');
  }

  /**
   * Wait for asteroid count to change from initial count
   */
  async waitForAsteroidCountChange(initialCount: number, timeoutMs: number = 10000): Promise<void> {
    await this.page.waitForFunction(
      (expectedInitialCount) => {
        const gameController = (window as any).gameController;
        if (gameController?.getCurrRoidBelt) {
          const roidBelt = gameController.getCurrRoidBelt();
          const currentCount = roidBelt ? roidBelt.getRoids().length : 0;
          console.log(`🔍 Waiting for asteroid count change: initial=${expectedInitialCount}, current=${currentCount}`);
          return currentCount !== expectedInitialCount;
        }
        console.log(`🔍 No game controller or roid belt available`);
        return false;
      },
      initialCount,
      { timeout: timeoutMs }
    );
    console.log(`✅ Asteroid count changed from initial count`);
  }

  /**
   * Check if the ship is currently exploding
   */
  async isShipExploding(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.playerManager?.getLocalPlayer) {
        const player = gameController.playerManager.getLocalPlayer();
        return player?.ship?.exploding || false;
      }
      return false;
    });
  }

  /**
   * Get the current number of lives
   */
  async getLives(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const nm = gc?.getNetworkManager?.();
      const localId = nm?.getLocalPlayerId?.();
      const fromNetwork = localId ? nm?.getPlayer?.(localId) : undefined;
      const local = gc?.playerManager?.getLocalPlayer?.();
      return fromNetwork?.lives ?? local?.lives ?? 0;
    });
  }

  /**
   * Wait for spawn protection to end
   */
  async waitForSpawnProtectionToEnd(timeoutMs: number = 10000): Promise<void> {
    await this.page.waitForFunction(
      () => {
        const gameController = (window as any).gameController;
        if (gameController?.playerManager?.getLocalPlayer) {
          const player = gameController.playerManager.getLocalPlayer();
          const ship = player?.ship;
          if (ship) {
            console.log(`🔍 Checking spawn protection: blinkCount=${ship.blinkCount}, spawnProtectionTimer=${ship.spawnProtectionTimer}`);
            return ship.blinkCount <= 0;
          }
        }
        return false;
      },
      { timeout: timeoutMs }
    );
    console.log('✅ Spawn protection ended');
  }

  /**
   * Check if ship has spawn protection
   */
  async hasSpawnProtection(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gameController = (window as any).gameController;
      if (gameController?.playerManager?.getLocalPlayer) {
        const player = gameController.playerManager.getLocalPlayer();
        const ship = player?.ship;
        return ship ? ship.blinkCount > 0 : false;
      }
      return false;
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
      const gc = (window as any).gameController;
      return gc?.getNetworkManager?.().getLocalPlayerId?.() ?? '';
    });
  }

  /** Current score of the local player (server-authoritative, synced down). */
  async getScore(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      return gc?.getCurrScore ? gc.getCurrScore() : 0;
    });
  }

  /**
   * Place the local ship at an exact world position, at rest, with spawn
   * protection cleared so collisions register on the next frame.
   */
  async placeShipAt(x: number, y: number): Promise<void> {
    await this.page.evaluate(
      ({ x, y }) => {
        const gc = (window as any).gameController;
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!ship) {
          throw new Error('No local ship to place');
        }
        ship.position = { x, y };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.angularVelocity = 0;
        ship.blinkCount = 0;
        ship.spawnProtectionTimer = 0;
      },
      { x, y }
    );
  }

  /**
   * Re-arm spawn protection so the ship stops colliding (lets a test land a
   * single collision and then stop, avoiding runaway chain collisions).
   */
  async armSpawnProtection(): Promise<void> {
    await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const ship = gc?.playerManager?.getLocalPlayer()?.ship;
      if (ship) {
        ship.blinkCount = 600;
        ship.spawnProtectionTimer = 600;
      }
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
      const gc = (window as any).gameController;
      const satellites = gc?.getSatellites?.() ?? [];
      return satellites.map((sat: any) => ({
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
        const gc = (window as any).gameController;
        return (gc?.getSatellites?.() ?? []).length >= expected;
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
        const gc = (window as any).gameController;
        const sat = (gc?.getSatellites?.() ?? []).find((s: any) => s.id === id);
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!sat || !ship) {
          return null;
        }
        ship.position = { x: sat.position.x - 45, y: sat.position.y };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.blinkCount = 600;
        ship.spawnProtectionTimer = 600;
        ship.angle = Math.atan2(-(sat.position.y - ship.position.y), sat.position.x - ship.position.x);
        ship.canShoot = true;
        ship.shoot();
        return { health: sat.health, exploding: sat.exploding };
      }, satelliteId);

      if (sample) {
        minHealthObserved = Math.min(minHealthObserved, sample.health);
        everExploding = everExploding || sample.exploding;
      }
      await this.page.waitForTimeout(160);

      const after = await this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const sat = (gc?.getSatellites?.() ?? []).find((s: any) => s.id === id);
        return sat ? { health: sat.health, exploding: sat.exploding } : null;
      }, satelliteId);
      if (after) {
        minHealthObserved = Math.min(minHealthObserved, after.health);
        everExploding = everExploding || after.exploding;
        if (after.exploding || after.health <= 0) break;
      }
    }

    const endScore = await this.getScore();
    return {
      minHealthObserved: Number.isFinite(minHealthObserved) ? minHealthObserved : 50,
      everExploding,
      scoreGain: endScore - startScore,
    };
  }

  async pinShipOnSatellite(satelliteId: string, durationMs = 2500): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await this.page.evaluate(
        ({ id }) => {
          const gc = (window as any).gameController;
          const sat = (gc?.getSatellites?.() ?? []).find((s: any) => s.id === id);
          const ship = gc?.playerManager?.getLocalPlayer()?.ship;
          if (sat && ship) {
            ship.position = { x: sat.position.x, y: sat.position.y };
            ship.velocity = { x: 0, y: 0 };
            ship.thrusting = false;
          }
        },
        { id: satelliteId }
      );
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
      const gc = (window as any).gameController;
      const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
      return players
        .filter((p: any) => p.type === 'bot')
        .map((p: any) => ({
          id: p.id,
          x: p.ship.position.x,
          y: p.ship.position.y,
          health: p.ship.health,
          maxHealth: p.ship.maxHealth,
          exploding: p.ship.exploding,
          r: p.ship.r,
          factionId: p.factionId ?? p.ship.factionId,
        }));
    });
  }

  /** Resolve a currently alive bot on the opposite assigned soft faction. */
  async getHostileBotId(timeoutMs = 25000): Promise<string> {
    await this.page.waitForFunction(
      () => {
        const gc = (window as any).gameController;
        const local = gc?.playerManager?.getLocalPlayer?.();
        const localFaction = local?.factionId ?? local?.ship?.factionId;
        if (!localFaction) {
          return false;
        }
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        return players.some((player: any) => {
          const faction = player.factionId ?? player.ship?.factionId;
          return player.type === 'bot' && player.ship && player.ship.health > 0 &&
            !player.ship.exploding && faction && faction !== localFaction;
        });
      },
      undefined,
      { timeout: timeoutMs, polling: 200 }
    );

    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer?.();
      const localFaction = local?.factionId ?? local?.ship?.factionId;
      const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
      const hostile = players.find((player: any) => {
        const faction = player.factionId ?? player.ship?.factionId;
        return player.type === 'bot' && player.ship && player.ship.health > 0 &&
          !player.ship.exploding && faction && faction !== localFaction;
      });
      if (!hostile?.id) {
        throw new Error(`No alive hostile bot found for local faction ${localFaction ?? 'unknown'}`);
      }
      return hostile.id;
    });
  }

  /** Wait for a bot's real laser shield to expire before the next shot. */
  async waitForBotShieldToClear(botId: string, timeoutMs = 15000): Promise<void> {
    await this.page.waitForFunction(
      (id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((player: any) => player.id === id);
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
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        return players.filter((p: any) => p.type === 'bot').length >= expected;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  /** Aim the ship at a world point and fire one laser. */
  async fireLaserToward(targetX: number, targetY: number): Promise<void> {
    await this.page.evaluate(
      ({ targetX, targetY }) => {
        const gc = (window as any).gameController;
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
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
        const gc = (window as any).gameController;
        const roids = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
        return !roids.some((r: any) => r.id === id);
      }, asteroid.id);

    const shipRadius = await this.getShipRadius();
    const findCurrentFiringLane = async (): Promise<{
      x: number;
      y: number;
    } | null> => {
      return await this.page.evaluate(
        ({ id, shipRadius }) => {
          const gc = (window as any).gameController;
          const roids = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
          const target = roids.find((roid: any) => roid.id === id);
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
            const clear = roids.every((roid: any) => {
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
              return Math.hypot(roid.position.x - closestX, roid.position.y - closestY) > roid.r + 8;
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
        const gc = (window as any).gameController;
        const roids = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
        const target = roids.find((roid: any) => roid.id === id);
        return target?.position
          ? { x: target.position.x, y: target.position.y }
          : null;
      }, asteroid.id);

    // Fire ONE laser at a time, stopping as soon as the target is destroyed.
    // Bursting would let follow-up lasers destroy the freshly-spawned fragments
    // (over-destruction), so we must fire the minimum needed.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await targetGone()) return;
      const lane = await findCurrentFiringLane();
      if (!lane) {
        await this.runGameFrames(1);
        continue;
      }

      await this.placeShipAt(lane.x, lane.y);
      await this.syncShipPositionToServer();
      await this.armSpawnProtection(); // invulnerable to incidental collisions while shooting

      // Re-read after the authoritative position acknowledgement: the target
      // may have moved while the server processed the placement update.
      const targetPosition = await currentTargetPosition();
      if (!targetPosition) return;
      await this.fireLaserToward(targetPosition.x, targetPosition.y);
      // Advance the game loop so the laser travels and collision/destroy messages run.
      for (let frame = 0; frame < 45; frame++) {
        if (await targetGone()) return;
        await this.runGameFrames(1);
      }
    }
    throw new Error(`Asteroid ${asteroid.id} was not destroyed by laser within ${timeoutMs}ms`);
  }

  /**
   * Drive a ship→asteroid collision: pin the ship on the asteroid and poll
   * until the hit registers (ship took damage), re-pinning each iteration so a
   * throttled game loop still lands it. As soon as the collision is detected,
   * move the ship center-ward and re-arm spawn protection — moving off the
   * impact point (where split fragments spawn) prevents a runaway chain
   * reaction, so the split reads as a clean increase.
   */
  async collideShipWithAsteroid(asteroid: { x: number; y: number }): Promise<void> {
    const startHealth = await this.getShipHealth();
    const deadline = Date.now() + 4000;
    let collided = false;
    while (Date.now() < deadline) {
      await this.placeShipAt(asteroid.x, asteroid.y);
      await this.page.waitForTimeout(80);
      if ((await this.getShipHealth()) < startHealth) {
        collided = true;
        break;
      }
    }
    // Peel away toward the origin and become invulnerable so we only register
    // the single intended collision (no chain reaction with split fragments).
    await this.page.evaluate(
      ({ x, y }) => {
        const gc = (window as any).gameController;
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!ship) return;
        const dist = Math.sqrt(x * x + y * y) || 1;
        const step = Math.min(400, dist);
        ship.position = { x: x - (x / dist) * step, y: y - (y / dist) * step };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.blinkCount = 600;
        ship.spawnProtectionTimer = 600;
      },
      { x: asteroid.x, y: asteroid.y }
    );
    if (!collided) {
      throw new Error('Ship never registered a collision with the asteroid');
    }
  }

  /**
   * Fire repeated, re-aimed laser volleys at a bot until it is destroyed (or
   * the shot budget is exhausted). Returns what was observed so the caller can
   * assert on real damage/kill signals.
   */
  async attackBotWithLasers(
    botId: string,
    shots = 8
  ): Promise<{ minHealthObserved: number; everExploding: boolean; scoreGain: number }> {
    const startScore = await this.getScore();
    let minHealthObserved = Number.POSITIVE_INFINITY;
    let everExploding = false;

    for (let i = 0; i < shots; i++) {
      const targetShielded = await this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((player: any) => player.id === id);
        return Boolean(bot?.ship?.shieldActive || (bot?.ship?.shieldTime ?? 0) > 0);
      }, botId);
      if (targetShielded) {
        // Do not park beside a shielded target while its AI remains active.
        // Move to a live in-bounds position, echo it to the server, and wait
        // on the authoritative shield countdown before re-entering the lane.
        await this.placeShipAt(-1800, 0);
        await this.syncShipPositionToServer();
        await this.waitForBotShieldToClear(botId);
      }

      const sample = await this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((p: any) => p.id === id);
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!bot || !ship) {
          return null;
        }
        // Keep the hulls separated and choose a firing lane without an
        // asteroid between muzzle and target. This is a shot scenario, not a ram.
        const bx = bot.ship.position.x;
        const by = bot.ship.position.y;
        const rocks = gc.getCurrRoidBelt().getRoids();
        const gap = ship.r + bot.ship.r + 12;
        let firingPoint: { x: number; y: number } | undefined;
        for (let direction = 0; direction < 16; direction++) {
          const angle = direction * Math.PI / 8;
          const x = bx + Math.cos(angle) * gap;
          const y = by + Math.sin(angle) * gap;
          if (Math.hypot(x, y) > 3000) continue;
          const clear = rocks.every((rock: any) => {
            const dx = bx - x;
            const dy = by - y;
            const t = Math.max(0, Math.min(1,
              ((rock.position.x - x) * dx + (rock.position.y - y) * dy) / (gap * gap)));
            return Math.hypot(rock.position.x - x - t * dx, rock.position.y - y - t * dy) > rock.r + 8;
          });
          if (clear) { firingPoint = { x, y }; break; }
        }
        if (!firingPoint) return null;
        ship.position = firingPoint;
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.blinkCount = 600;
        ship.spawnProtectionTimer = 600;
        return { health: bot.ship.health, exploding: bot.ship.exploding };
      }, botId);

      if (sample) {
        await this.syncShipPositionToServer();
        await this.page.evaluate((id) => {
          const gc = (window as any).gameController;
          const target = gc.getNetworkManager().getAllPlayers().find((p: any) => p.id === id)?.ship;
          const ship = gc.playerManager.getLocalPlayer().ship;
          if (!target || target.health <= 0 || target.exploding) return;
          ship.angle = Math.atan2(-(target.position.y - ship.position.y), target.position.x - ship.position.x);
          ship.canShoot = true;
          ship.shoot();
        }, botId);
        minHealthObserved = Math.min(minHealthObserved, sample.health);
        everExploding = everExploding || sample.exploding;
      }
      await this.page.waitForTimeout(160);

      // Sample again after the laser has had time to land.
      const after = await this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((p: any) => p.id === id);
        return bot ? { health: bot.ship.health, exploding: bot.ship.exploding } : null;
      }, botId);
      if (after) {
        minHealthObserved = Math.min(minHealthObserved, after.health);
        everExploding = everExploding || after.exploding;
        // Once the selected hostile bot is dead, stop issuing shots. The
        // server keeps bots firing during the same window, so continuing a
        // lethal volley can kill the fixture ship and make the next pose
        // acknowledgement impossible while it is exploding/respawning.
        if (after.exploding || after.health <= 0) {
          break;
        }
      }
    }

    if (!Number.isFinite(minHealthObserved)) {
      throw new Error(`No live health observation was available for bot ${botId}`);
    }
    const endScore = await this.getScore();
    return {
      minHealthObserved,
      everExploding,
      scoreGain: endScore - startScore,
    };
  }

  /**
   * Wait until the player can actually take damage. Freshly-spawned players get
   * server-side spawn protection during which ALL incoming damage is silently
   * ignored; tests that assert collision/boundary damage must wait it out. We
   * poll the server-authoritative spawn-protection timer (mirrored into the
   * local player from the gameState) so this is robust to server-loop timing
   * drift under load — far more reliable than a fixed sleep.
   */
  /** Wait until the local player is registered on the server (post-join). */
  async waitForServerJoin(timeoutMs = 60000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      try {
        await this.page.waitForFunction(
          () => {
            const gc = (window as any).gameController;
            const nm = gc?.getNetworkManager?.();
            if (!nm?.isConnected) {
              return false;
            }
            const id = nm.getLocalPlayerId?.();
            const lp = gc?.playerManager?.getLocalPlayer?.();
            return Boolean(id && lp);
          },
          undefined,
          { timeout: Math.min(5000, remaining), polling: 200 }
        );
        return;
      } catch {
        await this.page
          .evaluate(async () => {
            const gc = (window as any).gameController;
            const nm = gc?.getNetworkManager?.();
            if (!nm?.isConnected) {
              await nm.connect();
              nm.initializeAsteroidSync?.();
            }
          })
          .catch(() => {});
      }
    }
    throw new Error(`Timed out waiting for server join after ${timeoutMs}ms`);
  }

  async waitForCombatReady(timeoutMs = 45000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.page.evaluate(() => {
        const player = (window as any).gameController?.playerManager?.getLocalPlayer?.();
        const ship = player?.ship;
        if (!ship) {
          return false;
        }
        // Client frames can advance faster than the authoritative server clock.
        // Wait for both the server expiry and the local collision window.
        return ship.health > 0 && !ship.exploding && (ship.blinkCount ?? 0) === 0
          && player.serverSpawnProtectionTimer === 0;
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

    while (Date.now() < deadline) {
      const clientCount = await this.getAsteroidCount();
      if (clientCount >= minCount) {
        return;
      }

      const world = await TestServerControl.getWorldDiagnostics().catch(() => null);
      if (world && world.asteroids >= minCount) {
        await this.runGameFrames(5);
      } else {
        await this.page.waitForTimeout(200);
      }
    }

    const clientCount = await this.getAsteroidCount();
    const world = await TestServerControl.getWorldDiagnostics().catch(() => null);
    throw new Error(
      `Timed out waiting for ${minCount} synced asteroid(s): client=${clientCount}, server=${world?.asteroids ?? 'unknown'}`
    );
  }

  /** Poll server.log for a pattern written after `logLineOffset`. */
  async waitForServerLogPattern(
    pattern: RegExp,
    logLineOffset: number,
    timeoutMs = 15000
  ): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = ServerLogHelper.findMatchingLinesSince(logLineOffset, pattern);
      if (matches.length > 0) {
        return matches;
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for server log pattern ${pattern}`);
  }

  /**
   * Pin the ship on an asteroid (and the fragments that spawn there) until the
   * sustained collisions destroy it — used to exercise the death→respawn flow.
   * Each hit is 25 damage, so the ship dies after several collisions. Returns
   * once the server reports the ship as exploding or out of health.
   */
  async crashShipIntoAsteroidUntilDestroyed(asteroid: { x: number; y: number }): Promise<void> {
    const startLives = await this.getLives();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await this.page.evaluate(
        async ({ ax, ay }) => {
          const gc = (window as any).gameController;
          const player = gc?.playerManager?.getLocalPlayer();
          const ship = player?.ship;
          if (!gc?.updateGame || !ship) {
            throw new Error('Local ship unavailable for asteroid crash');
          }
          ship.position = { x: ax, y: ay };
          ship.velocity = { x: 0, y: 0 };
          ship.thrusting = false;
          ship.angularVelocity = 0;
          ship.blinkCount = 0;
          ship.spawnProtectionTimer = 0;
          if (player) {
            player.serverSpawnProtectionTimer = 0;
          }
          for (let frame = 0; frame < 40; frame++) {
            ship.position = { x: ax, y: ay };
            gc.updateGame();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
        },
        { ax: asteroid.x, ay: asteroid.y }
      );
      const [exploding, health, lives] = await Promise.all([
        this.isShipExploding(),
        this.getShipHealth(),
        this.getLives(),
      ]);
      if (exploding || health <= 0 || lives < startLives) {
        // Move off the impact point so split fragments cannot re-damage the
        // ship while we wait for the server respawn reposition.
        await this.page.evaluate(
          ({ x, y }) => {
            const gc = (window as any).gameController;
            const ship = gc?.playerManager?.getLocalPlayer()?.ship;
            if (!ship) return;
            const dist = Math.sqrt(x * x + y * y) || 1;
            const step = Math.min(400, dist);
            ship.position = { x: x - (x / dist) * step, y: y - (y / dist) * step };
            ship.velocity = { x: 0, y: 0 };
          },
          { x: asteroid.x, y: asteroid.y }
        );
        return;
      }

      // Keep the predicted pose pinned and echo it so the server loop
      // can apply the only remaining asteroid-ram path.
      await this.page.evaluate(({ ax, ay }) => {
        const gc = (window as any).gameController;
        const nm = gc?.getNetworkManager?.();
        const playerId = nm?.getLocalPlayerId?.();
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (ship) {
          ship.position = { x: ax, y: ay };
          ship.velocity = { x: 0, y: 0 };
        }
        if (nm && playerId) {
          nm.sendMessage({
            type: 'update',
            id: playerId,
            position: { x: ax, y: ay },
            velocity: { x: 0, y: 0 },
          });
        }
      }, { ax: asteroid.x, ay: asteroid.y });
      await this.page.waitForTimeout(50);
    }
    throw new Error('Ship was not destroyed by sustained asteroid collision');
  }

  /** Distance of the local ship from the world origin (boundary is a circle). */
  async getShipDistanceFromCenter(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const ship = gc?.playerManager?.getLocalPlayer()?.ship;
      if (!ship) return 0;
      return Math.sqrt(ship.position.x * ship.position.x + ship.position.y * ship.position.y);
    });
  }

  /**
   * Wait for the server snapshot to acknowledge the fixture position before
   * triggering server-authoritative damage, on either negotiated wire format.
   */
  async syncShipPositionToServer(): Promise<void> {
    await this.page.evaluate(async () => {
      const gc = (window as any).gameController;
      const nm = gc.getNetworkManager();
      const socket = nm.connectionManager.state.socket as WebSocket | null;
      const playerId = nm.getLocalPlayerId();
      const position = { ...gc.playerManager.getLocalPlayer().ship.position };
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Local socket is not open');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timeout); socket.removeEventListener('message', onMessage); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Server did not acknowledge fixture position')); }, 5000);
        const onMessage = (event: MessageEvent) => {
          const message = JSON.parse(event.data);
          const data = message.data;
          const rows = message.type === 'gameState' ? data.entities
            : data?.kind === 'keyframe' ? data.state.entities
            : data?.kind === 'delta' ? data.patch.set.entities : undefined;
          const row = rows?.find((entry: any) => entry.id === playerId)
            ?? data?.patch?.collections?.entities?.update?.find((entry: any) => entry[0] === playerId)?.[1];
          if (row?.position && Math.hypot(row.position.x - position.x, row.position.y - position.y) < 20) {
            cleanup(); resolve();
          }
        };
        socket.addEventListener('message', onMessage);
        nm.sendMessage({ type: 'update', id: playerId, position, velocity: { x: 0, y: 0 } });
      });
    });
  }

  async killLocalPlayerWithLaserDamage(
    hits = 4,
    damagePerHit = 25,
    attackerId?: string
  ): Promise<void> {
    const hostileBotId = attackerId ?? await this.getHostileBotId();
    await this.page.evaluate(
      async ({ hits, damagePerHit, attackerId }) => {
        const gc = (window as any).gameController;
        const nm = gc?.getNetworkManager?.();
        const playerId =
          nm?.getLocalPlayerId?.() || gc?.playerManager?.getLocalPlayer?.()?.id;
        if (!nm || !playerId) {
          throw new Error('Cannot apply laser damage — local player not connected');
        }
        for (let i = 0; i < hits; i++) {
          nm.sendMessage({
            type: 'laserDamage',
            data: {
              targetPlayerId: playerId,
              attackerId,
              damage: damagePerHit,
            },
          });
          for (let frame = 0; frame < 8; frame++) {
            gc.updateGame();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        for (let frame = 0; frame < 45; frame++) {
          gc.updateGame();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      },
      { hits, damagePerHit, attackerId: hostileBotId }
    );
  }

  /** Apply laser damage until the server reports a life lost (handles spawn protection drift). */
  async killLocalPlayerUntilLifeLost(timeoutMs = 30000): Promise<void> {
    const livesBefore = await this.getLives();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.waitForCombatReady();
      // Re-resolve each attempt: bots can be destroyed or respawning while a
      // prior damage volley is in flight, so never fall back to a fixed bot id.
      const hostileBotId = await this.getHostileBotId();
      await this.killLocalPlayerWithLaserDamage(4, 25, hostileBotId);
      await this.runGameFrames(15);
      if ((await this.getLives()) < livesBefore) {
        return;
      }
    }
    throw new Error('laser damage should cost a life');
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
        const ship = (window as any).gameController?.playerManager?.getLocalPlayer()?.ship;
        if (!ship || ship.health <= 0) {
          return false;
        }
        const fromDeath = Math.hypot(
          ship.position.x - death.x,
          ship.position.y - death.y
        );
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
          const gc = (window as any).gameController;
          const player = gc?.playerManager?.getLocalPlayer();
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
    const debug = await this.page.evaluate(({ deathPosition }) => {
      const gc = (window as any).gameController;
      const player = gc?.playerManager?.getLocalPlayer();
      const ship = player?.ship;
      return {
        health: ship?.health,
        exploding: ship?.exploding,
        position: ship?.position,
        lives: player?.lives,
        deathPosition,
      };
    }, { deathPosition });
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
      const gc = (window as any).gameController;
      return gc?.getIsGameRunning?.() ?? false;
    });
  }

  /** Whether the latest complete server snapshot still grants protection. */
  async isServerSpawnProtected(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const player = gc?.playerManager?.getLocalPlayer?.();
      return (player?.serverSpawnProtectionTimer ?? 0) > 0;
    });
  }

  /** Kill banner text from GameStateManager (empty when inactive). */
  async getKillMessage(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      return gc?.getGameStateManager?.().getKillMessage?.() ?? '';
    });
  }

  /** HUD overlay text (game over, death messages). */
  async getHudText(): Promise<string> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      return gc?.getText?.() ?? '';
    });
  }

  /** Whether the start screen is visible again. */
  async isStartScreenVisible(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const el = document.getElementById('start-screen');
      return el ? el.style.display !== 'none' : false;
    });
  }

  /** Leaderboard rows derived from synced player entities. */
  async getLeaderboardEntries(): Promise<
    Array<{ name: string; score: number; type: string; id: string }>
  > {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer?.();
      const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
      const all = local && !players.includes(local) ? [local, ...players] : players;
      return all
        .map((p: any) => ({
          name: p.name,
          score: p.score ?? 0,
          type: p.type,
          id: p.id,
        }))
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score);
    });
  }

  /** Count of active lasers on the local ship. */
  async getLaserCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      return gc?.playerManager?.getLocalPlayer()?.ship?.lasers?.length ?? 0;
    });
  }

  /** Local ship heading in radians. */
  async getShipAngle(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      return gc?.playerManager?.getLocalPlayer()?.ship?.angle ?? 0;
    });
  }

  /** All players known to the client (includes local when synced). */
  async getAllPlayerCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer?.();
      const remote = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
      const ids = new Set<string>();
      if (local?.id) ids.add(local.id);
      for (const p of remote) ids.add(p.id);
      return ids.size;
    });
  }

  /** Wait until at least `minCount` remote human players are visible. */
  async waitForRemoteHumanPlayers(minCount = 1, timeoutMs = 20000): Promise<void> {
    await this.page.waitForFunction(
      (expected) => {
        const gc = (window as any).gameController;
        const localId = gc?.getNetworkManager?.().getLocalPlayerId?.();
        const remotes = (gc?.getNetworkManager?.().getAllPlayers?.() ?? []).filter(
          (p: any) => p.type === 'remote' && p.id !== localId
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
      const gc = (window as any).gameController;
      const localId = gc?.getNetworkManager?.().getLocalPlayerId?.();
      return (gc?.getNetworkManager?.().getAllPlayers?.() ?? [])
        .filter((p: any) => p.type === 'remote' && p.id !== localId)
        .map((p: any) => p.id);
    });
  }

  /** Network-synced ship position for any player id known to this client. */
  async getNetworkPlayerPosition(playerId: string): Promise<{ x: number; y: number } | null> {
    return await this.page.evaluate((id) => {
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer?.();
      if (local?.id === id) {
        return { x: local.ship.position.x, y: local.ship.position.y };
      }
      const found = (gc?.getNetworkManager?.().getAllPlayers?.() ?? []).find(
        (p: any) => p.id === id
      );
      if (!found?.ship) {
        return null;
      }
      return { x: found.ship.position.x, y: found.ship.position.y };
    }, playerId);
  }

  /** Apply chip damage through the server (authoritative health sync). */
  async applyServerChipDamage(amount = 25, attackerId?: string): Promise<void> {
    await this.applyLaserDamageToLocal(1, amount, attackerId);
  }

  /** @deprecated Use applyServerChipDamage — local-only damage is overwritten by server snapshots. */
  async applyLocalChipDamage(amount = 25, attackerId?: string): Promise<void> {
    await this.applyServerChipDamage(amount, attackerId);
  }

  /** Apply laser damage without killing (single hit by default). */
  async applyLaserDamageToLocal(hits = 1, damagePerHit = 25, attackerId?: string): Promise<void> {
    const hostileBotId = attackerId ?? await this.getHostileBotId();
    await this.page.evaluate(({ hits, damagePerHit, attackerId }) => {
      const gc = (window as any).gameController;
      const nm = gc?.getNetworkManager?.();
      const playerId = nm?.getLocalPlayerId?.();
      if (!nm || !playerId) throw new Error('Local player is not connected');
      for (let i = 0; i < hits; i++) {
        nm.sendMessage({
          type: 'laserDamage',
          data: { targetPlayerId: playerId, attackerId, damage: damagePerHit },
        });
      }
    }, { hits, damagePerHit, attackerId: hostileBotId });
  }

  /** Poll until local health exceeds a threshold. */
  async waitForHealthAbove(threshold: number, timeoutMs = 15000): Promise<number> {
    await this.page.waitForFunction(
      (minimumHealth) => {
        const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
        return ship?.health > minimumHealth;
      },
      threshold,
      { timeout: timeoutMs, polling: 100 }
    ).catch(async () => {
      throw new Error(
        `Timed out waiting for health above ${threshold} (got ${await this.getShipHealth()})`
      );
    });
    return this.getShipHealth();
  }

  /** Pin the local ship on a bot so ship-to-ship collision damage applies. */
  async pinShipOnBot(botId: string, durationMs = 2500): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await this.page.evaluate(
        ({ id }) => {
          const gc = (window as any).gameController;
          const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
          const bot = players.find((p: any) => p.id === id);
          const ship = gc?.playerManager?.getLocalPlayer()?.ship;
          if (bot?.ship && ship) {
            ship.position = { x: bot.ship.position.x, y: bot.ship.position.y };
            ship.velocity = { x: 0, y: 0 };
            ship.thrusting = false;
          }
        },
        { id: botId }
      );
      await this.page.waitForTimeout(100);
    }
  }

  /** Apply laser-style bot damage from the local human (asteroid ram is server-owned). */
  async damageBot(botId: string, damage: number, attackerId?: string): Promise<void> {
    await this.page.evaluate(
      ({ botId, damage, attackerId }) => {
        const gc = (window as any).gameController;
        const nm = gc?.getNetworkManager?.();
        const reporterId =
          !attackerId || attackerId === 'asteroid' || String(attackerId).startsWith('asteroid')
            ? nm?.getLocalPlayerId?.()
            : attackerId;
        nm?.sendMessage?.({
          type: 'botDamage',
          data: { botId, attackerId: reporterId, damage },
        });
      },
      { botId, damage, attackerId }
    );
    await this.page.waitForTimeout(200);
  }

  /** Poll until a bot finishes respawning at full health. */
  async waitForBotRespawn(botId: string, timeoutMs = 20000): Promise<{ x: number; y: number }> {
    await this.page.waitForFunction(
      (id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((p: any) => p.id === id);
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
    if (!bot) throw new Error(`Bot ${botId} missing after respawn`);
    return { x: bot.x, y: bot.y };
  }

  async dieOnceViaBoundary(): Promise<void> {
    await this.waitForCombatReady();
    const livesBefore = await this.getLives();
    const deathPosition = { x: 3150, y: 0 };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await this.placeShipAt(deathPosition.x, deathPosition.y);
      await this.page.waitForTimeout(200);
      if ((await this.getLives()) < livesBefore) {
        if ((await this.getLives()) > 0 && (await this.isGameRunning())) {
          await this.waitForShipRespawn(deathPosition, 25000);
        }
        return;
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
      await this.waitForCombatReady();
      await this.killLocalPlayerUntilLifeLost(15000);
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
        const gc = (window as any).gameController;
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
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
    await this.page.evaluate(
      (targetId) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const target = players.find((p: any) => p.id === targetId);
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!target?.ship || !ship) {
          throw new Error('Shooter or target ship unavailable');
        }
        const tx = target.ship.position.x;
        const ty = target.ship.position.y;
        ship.position = { x: tx - 45, y: ty };
        ship.velocity = { x: 0, y: 0 };
        ship.blinkCount = 0;
        ship.spawnProtectionTimer = 0;
        ship.angle = Math.atan2(-(ty - ship.position.y), tx - ship.position.x);
        ship.canShoot = true;
        ship.shoot();
      },
      targetPlayerId
    );
    await this.page.waitForTimeout(300);
  }

  /** Read a remote player's synced health by id. */
  async getPlayerHealthById(playerId: string): Promise<number> {
    return await this.page.evaluate((id) => {
      const gc = (window as any).gameController;
      const local = gc?.playerManager?.getLocalPlayer?.();
      if (local?.id === id) return local.ship.health;
      const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
      const found = players.find((p: any) => p.id === id);
      return found?.ship?.health ?? -1;
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
      const gc = (window as any).gameController;
      const pickups = gc?.getSatellitePickups?.() ?? [];
      return pickups.map((pickup: any) => ({
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
        const gc = (window as any).gameController;
        return (gc?.getSatellitePickups?.() ?? []).length >= expected;
      },
      count,
      { timeout: timeoutMs }
    );
  }

  async pinShipOnSatellitePickup(pickupId: string, durationMs = 2000): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      await this.page.evaluate(
        ({ id }) => {
          const gc = (window as any).gameController;
          const pickup = (gc?.getSatellitePickups?.() ?? []).find((item: any) => item.id === id);
          const ship = gc?.playerManager?.getLocalPlayer()?.ship;
          if (pickup && ship) {
            ship.position = { x: pickup.position.x, y: pickup.position.y };
            ship.velocity = { x: 0, y: 0 };
            ship.thrusting = false;
          }
        },
        { id: pickupId }
      );
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
