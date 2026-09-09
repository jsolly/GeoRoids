import { expect, test } from 'vitest';
import type { ConnectionManager } from '../../../../src/network/services/ConnectionManager';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const CREAM = '#E8D5A3';
const TIP = '#FDE68A';

test(
  'Hauler shows a live cable and keeps its latch through a brief socket flap',
  async () => {
    const page = browserManager.getCurrentPage();
    if (!page) {
      throw new Error('Page not available');
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    const game = new GameInteractions(page);
    await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
    const peerPage = await browserManager.createAdditionalPage();
    const peer = new GameInteractions(peerPage);
    await peer.bootGame({ waitForCombatReady: false });
    await page.bringToFront();

    await game.waitForAsteroids(1);
    const fixture = await page.evaluate(() => {
      const gc = window.gameController;
      const player = gc?.getCurrPlayer();
      const ship = player?.ship;
      const rocks = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
      const actors = (gc?.getNetworkManager?.().getAllPlayers?.() ?? [])
        .filter(
          (actor) => actor.id !== player?.id && actor.ship?.health > 0 && !actor.ship.exploding
        )
        .map((actor) => actor.ship.position);
      const satellites = (gc?.getSatellites?.() ?? [])
        .filter((satellite) => satellite.health > 0 && !satellite.exploding)
        .map((satellite) => satellite.position);
      const hazards = [...actors, ...satellites];
      if (!ship || rocks.length === 0) {
        throw new Error('Hauler fixture requires the local ship and a live asteroid');
      }
      const rock = rocks
        .filter((candidate) => candidate.health > 0)
        .map((candidate) => ({
          candidate,
          clearance:
            hazards.length + rocks.length > 1
              ? Math.min(
                  ...hazards.map((position: { x: number; y: number }) =>
                    Math.hypot(candidate.position.x - position.x, candidate.position.y - position.y)
                  ),
                  ...rocks
                    .filter((other) => other.id !== candidate.id)
                    .map(
                      (other) =>
                        Math.hypot(
                          candidate.position.x - other.position.x,
                          candidate.position.y - other.position.y
                        ) -
                        candidate.r -
                        other.r
                    )
                )
              : Number.POSITIVE_INFINITY,
        }))
        .sort((left, right) => right.clearance - left.clearance)[0]?.candidate;
      if (!rock) {
        throw new Error('Hauler fixture did not find a live asteroid clear of other actors');
      }
      const distance = Math.hypot(rock.position.x, rock.position.y) || 1;
      const gap = rock.r + ship.r + 60;
      return {
        targetId: rock.id,
        position: {
          x: rock.position.x + (rock.position.x / distance) * gap,
          y: rock.position.y + (rock.position.y / distance) * gap,
        },
        kitId: player?.ship?.kitId,
        selected: document.querySelector('[data-kit-id="hauler"]')?.getAttribute('aria-pressed'),
        joined: Boolean(gc?.getNetworkManager?.()?.getLocalPlayerId?.()),
      };
    });
    expect(fixture.kitId).toBe('hauler');
    expect(fixture.selected).toBe('true');
    expect(fixture.joined).toBe(true);
    await game.placeShipAt(fixture.position.x, fixture.position.y);

    await page.keyboard.press('e');

    const frames: Array<Record<string, unknown>> = [];
    const sampleDeadline = Date.now() + 1000;
    while (Date.now() < sampleDeadline) {
      const sample = await page.evaluate(
        ({ colors }: { colors: { cream: string; tip: string }; targetId: string }) => {
          const gc = window.gameController;
          gc?.renderGame?.();
          const ship = gc?.getCurrPlayer()?.ship;
          const probe = gc?.diagnoseHarpoon?.();
          const canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
          const ctx = canvas?.getContext('2d');
          const pixels =
            ctx && canvas ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
          const near = (hex: string, tolerance: number): boolean => {
            if (!pixels) {
              return false;
            }
            const r = Number.parseInt(hex.slice(1, 3), 16);
            const g = Number.parseInt(hex.slice(3, 5), 16);
            const b = Number.parseInt(hex.slice(5, 7), 16);
            for (let i = 0; i < pixels.length; i += 4) {
              if (
                Math.abs((pixels[i] ?? 0) - r) <= tolerance &&
                Math.abs((pixels[i + 1] ?? 0) - g) <= tolerance &&
                Math.abs((pixels[i + 2] ?? 0) - b) <= tolerance &&
                (pixels[i + 3] ?? 0) > 180
              ) {
                return true;
              }
            }
            return false;
          };
          return {
            kitId: ship?.kitId,
            findTarget: probe?.targetId ?? probe?.liveTargetId ?? null,
            harpoonTimer: ship?.harpoonTimer ?? 0,
            abilityActiveFrames: ship?.abilityActiveFrames ?? 0,
            latchPos: ship?.harpoonLatchPos ?? null,
            fieldCount: probe?.fieldCount ?? 0,
            scale: probe?.scale ?? null,
            range: probe?.range ?? null,
            nearest: probe?.nearest ?? null,
            connected: probe?.connected ?? null,
            cream: near(colors.cream, 22),
            tip: near(colors.tip, 22),
          };
        },
        { colors: { cream: CREAM, tip: TIP }, targetId: fixture.targetId }
      );
      frames.push(sample);
      if (sample.cream && sample.tip && sample.harpoonTimer > 0) {
        break;
      }
      await page.waitForTimeout(16);
    }

    const best =
      [...frames].reverse().find((frame) => frame['cream'] && frame['tip']) ?? frames.at(-1);
    expect(best?.['kitId']).toBe('hauler');
    expect(best?.['harpoonTimer']).toBeGreaterThan(0);
    expect(best?.['findTarget']).toBe(fixture.targetId);
    expect(best?.['latchPos']).toBeTruthy();
    expect(best?.['cream']).toBe(true);
    expect(best?.['tip']).toBe(true);

    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-live-tether.png'),
    });
    let rejoined = false;
    let freshWorld = false;
    // Only sockets opened after the initial join can satisfy this barrier.
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const message: unknown = JSON.parse(String(payload));
        if (!message || typeof message !== 'object' || !('type' in message)) {
          return;
        }
        if (message.type === 'joined') {
          rejoined = true;
        }
        if (rejoined && (message.type === 'snapshot' || message.type === 'gameState')) {
          freshWorld = true;
        }
      })
    );
    const connection = await page.evaluateHandle<ConnectionManager>(
      "import('/src/network/services/ConnectionManager.ts').then(({ ConnectionManager }) => ConnectionManager.getInstance())"
    );
    const flap = await page
      .evaluate(async (connection) => {
        const gc = window.gameController;
        if (!gc) {
          throw new Error('Game controller unavailable');
        }
        const player = gc.getCurrPlayer();
        if (!player) {
          throw new Error('Local player unavailable');
        }
        const ship = player.ship;
        const socket = connection.getSocket();
        if (!socket) {
          throw new Error('Gameplay socket unavailable');
        }
        const targetId = ship.harpoonTargetId;
        const startedAt = Date.now();
        const closed = new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(
            () => reject(new Error('Gameplay socket did not close')),
            2500
          );
          socket.addEventListener(
            'close',
            () => {
              window.clearTimeout(timer);
              resolve();
            },
            { once: true }
          );
        });
        socket.close(4000, 'Browser regression: brief connection flap');
        await closed;
        return {
          startedAt,
          targetId,
          timer: ship.harpoonTimer,
          rocks: gc.getCurrRoidBelt().getRoids().length,
          health: ship.health,
          lives: player.lives,
        };
      }, connection)
      .finally(() => connection.dispose());
    expect(flap.timer).toBeGreaterThan(0);
    expect(flap.rocks).toBeGreaterThan(0);
    const reconnectWaitStartedAt = Date.now();
    await page.waitForFunction(
      () => {
        const gc = window.gameController;
        return gc?.getNetworkManager().isConnected === true;
      },
      undefined,
      { timeout: 2500 }
    );
    const reconnectedAt = Date.now();
    await expect
      .poll(() => freshWorld, {
        timeout: 2500,
        message: 'Rejoined socket must receive a fresh authoritative world',
      })
      .toBe(true);
    const resumed = await page.evaluate(() => {
      const gc = window.gameController;
      const player = gc?.getCurrPlayer();
      if (!gc || !player) {
        throw new Error('Reconnected pilot unavailable');
      }
      const ship = player.ship;
      const targetId = ship.harpoonTargetId;
      const rocks = gc.getCurrRoidBelt().getRoids();
      return {
        targetId,
        timer: ship.harpoonTimer,
        rocks: rocks.map((rock: { id: string }) => rock.id).sort(),
        targetInField: rocks.some((rock: { id: string }) => rock.id === targetId),
        health: ship.health,
        lives: player.lives,
        connected: Boolean(gc.getNetworkManager()?.isConnected),
      };
    });
    console.log(
      '[hauler-reconnect]',
      JSON.stringify({
        flap,
        reconnectWaitMs: reconnectedAt - reconnectWaitStartedAt,
        postReconnectMs: Date.now() - reconnectedAt,
        resumed,
      })
    );
    expect(resumed.timer).toBeGreaterThan(0);
    expect(resumed.targetId).toBe(flap.targetId);
    expect(resumed.rocks.length).toBeGreaterThan(0);
    const peerRocks = (await peer.getAsteroidPositions()).map((rock) => rock.id).sort();
    expect(resumed.rocks).toEqual(peerRocks);
    await page.screenshot({
      path: screenshotManager.getScreenshotPath('hauler-after-reconnect.png'),
    });
    expect(consoleErrors).toEqual([]);
  },
  TestConfig.DEFAULT_TIMEOUT
);
