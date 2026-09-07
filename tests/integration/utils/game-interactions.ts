import { Page } from 'playwright';
import { TestConfig } from './test-config';
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
    const canvas = this.page.locator('canvas');
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
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.runGameFrames(8);
      if ((await this.getShipHealth()) === expected) {
        return;
      }
    }
    throw new Error(`Timed out waiting for ship health ${expected} (got ${await this.getShipHealth()})`);
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
    Array<{ x: number; y: number; radius: number; id: string; isCollabTarget?: boolean }>
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
        const player = gc?.playerManager?.getLocalPlayer();
        if (player) {
          player.serverSpawnProtectionTimer = 0;
        }
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

  /** Snapshot of all bots the client currently knows about. */
  async getBots(): Promise<
    Array<{ id: string; x: number; y: number; health: number; maxHealth: number; exploding: boolean; r: number }>
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
        }));
    });
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
   * is consumed on its first hit). The ship is parked just *center-ward* of the
   * asteroid — keeping it safely inside the boundary — and fires outward at the
   * target over a short, low-interception path. Resolves once the asteroid is
   * gone from the belt.
   */
  async destroyAsteroidWithLaser(
    asteroid: { x: number; y: number; id: string; radius: number },
    timeoutMs = 15000
  ): Promise<void> {
    const dist = Math.sqrt(asteroid.x * asteroid.x + asteroid.y * asteroid.y);
    const gap = asteroid.radius + 30; // park just off the asteroid edge for a fast hit
    let shipX: number;
    let shipY: number;
    if (dist < 1) {
      shipX = asteroid.x - gap;
      shipY = asteroid.y;
    } else {
      // Move from the asteroid toward the origin so the ship stays in-bounds.
      shipX = asteroid.x - (asteroid.x / dist) * gap;
      shipY = asteroid.y - (asteroid.y / dist) * gap;
    }

    await this.placeShipAt(shipX, shipY);
    await this.syncShipPositionToServer();
    await this.armSpawnProtection(); // invulnerable to ship-asteroid collisions while shooting

    const targetGone = () =>
      this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const roids = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
        return !roids.some((r: any) => r.id === id);
      }, asteroid.id);

    // Fire ONE laser at a time, stopping as soon as the target is destroyed.
    // Bursting would let follow-up lasers destroy the freshly-spawned fragments
    // (over-destruction), so we must fire the minimum needed.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await targetGone()) return;
      await this.fireLaserToward(asteroid.x, asteroid.y);
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
      const sample = await this.page.evaluate((id) => {
        const gc = (window as any).gameController;
        const players = gc?.getNetworkManager?.().getAllPlayers?.() ?? [];
        const bot = players.find((p: any) => p.id === id);
        const ship = gc?.playerManager?.getLocalPlayer()?.ship;
        if (!bot || !ship) {
          return null;
        }
        // Park next to the bot, aimed at it, and fire immediately so the laser
        // reaches the (slow-moving) bot before it can drift out of the path.
        const bx = bot.ship.position.x;
        const by = bot.ship.position.y;
        ship.position = { x: bx - 45, y: by };
        ship.velocity = { x: 0, y: 0 };
        ship.thrusting = false;
        ship.blinkCount = 600; // stay invulnerable while dueling the bot
        ship.spawnProtectionTimer = 600;
        ship.angle = Math.atan2(-(by - ship.position.y), bx - ship.position.x);
        ship.canShoot = true;
        ship.shoot();
        return { health: bot.ship.health, exploding: bot.ship.exploding };
      }, botId);

      if (sample) {
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
      }
    }

    const endScore = await this.getScore();
    return {
      minHealthObserved: Number.isFinite(minHealthObserved) ? minHealthObserved : 100,
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
        const ship = (window as any).gameController?.playerManager?.getLocalPlayer?.()?.ship;
        if (!ship) {
          return false;
        }
        // #467 lean snapshots omit expired spawnProtectionTimer; the last
        // positive echo sticks on serverSpawnProtectionTimer. Collisions
        // use the ship blink window, so that is what "combat ready" means.
        return ship.health > 0 && !ship.exploding && (ship.blinkCount ?? 0) === 0;
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
   * Let a few network ticks propagate the client ship transform to the server
   * before triggering server-authoritative damage.
   */
  async syncShipPositionToServer(): Promise<void> {
    await this.runGameFrames(20);
    await this.page.waitForTimeout(200);
  }

  async killLocalPlayerWithLaserDamage(hits = 4, damagePerHit = 25): Promise<void> {
    await this.page.evaluate(
      async ({ hits, damagePerHit }) => {
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
              attackerId: 'server-bot-0',
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
      { hits, damagePerHit }
    );
  }

  /** Apply laser damage until the server reports a life lost (handles spawn protection drift). */
  async killLocalPlayerUntilLifeLost(timeoutMs = 30000): Promise<void> {
    const livesBefore = await this.getLives();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.waitForCombatReady();
      await this.killLocalPlayerWithLaserDamage(4, 25);
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

  /** Server-authoritative spawn protection is still active. */
  async isServerSpawnProtected(): Promise<boolean> {
    return await this.page.evaluate(() => {
      const gc = (window as any).gameController;
      const lp = gc?.playerManager?.getLocalPlayer?.();
      return (lp?.serverSpawnProtectionTimer ?? 0) > 0;
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
  async applyServerChipDamage(amount = 25, attackerId = 'server-bot-0'): Promise<void> {
    await this.page.evaluate(
      async ({ damage, attackerId }) => {
        const gc = (window as any).gameController;
        const nm = gc?.getNetworkManager?.();
        const playerId = nm?.getLocalPlayerId?.();
        if (!nm || !playerId) {
          throw new Error('Cannot apply server chip damage — not connected');
        }
        nm.sendMessage({
          type: 'laserDamage',
          data: {
            targetPlayerId: playerId,
            attackerId,
            damage,
          },
        });
        for (let frame = 0; frame < 30; frame++) {
          gc.updateGame();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      },
      { damage: amount, attackerId }
    );
  }

  /** @deprecated Use applyServerChipDamage — local-only damage is overwritten by server snapshots. */
  async applyLocalChipDamage(amount = 25): Promise<void> {
    await this.applyServerChipDamage(amount);
  }

  /** Apply laser damage without killing (single hit by default). */
  async applyLaserDamageToLocal(hits = 1, damagePerHit = 25): Promise<void> {
    await this.killLocalPlayerWithLaserDamage(hits, damagePerHit);
  }

  /** Poll until local health exceeds a threshold. */
  async waitForHealthAbove(threshold: number, timeoutMs = 15000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.runGameFrames(8);
      const health = await this.getShipHealth();
      if (health > threshold) {
        return health;
      }
    }
    throw new Error(
      `Timed out waiting for health above ${threshold} (got ${await this.getShipHealth()})`
    );
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
        return Boolean(bot?.ship && bot.ship.health === 100 && !bot.ship.exploding);
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
        return Boolean(ship && ship.health === 100 && !ship.exploding);
      },
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
}
