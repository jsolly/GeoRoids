import { test, expect } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';

const { browserManager, screenshotManager } = createBrowserScenarioHooks(__dirname);

const CREAM = '#E8D5A3';
const TIP = '#FDE68A';

test.each([
  { viewport: 'desktop', width: 1920, height: 1080 },
  { viewport: 'mobile', width: 390, height: 844 },
])('Hauler keeps its cable through a brief socket flap at $viewport width', async ({ viewport, width, height }) => {
  const page = browserManager.getCurrentPage();
  if (!page) throw new Error('Page not available');

  await page.setViewportSize({ width, height });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const game = new GameInteractions(page);
  await game.bootGame({ waitForCombatReady: false, kitId: 'hauler' });
  const peerPage = await browserManager.createAdditionalPage();
  const peer = new GameInteractions(peerPage);
  await peer.bootGame({ waitForCombatReady: false });
  await page.bringToFront();

  const before = await page.evaluate(() => {
    const gc = (window as { gameController?: any }).gameController;
    const player = gc?.playerManager?.getLocalPlayer?.();
    return {
      kitId: player?.ship?.kitId,
      selected: document.querySelector('[data-kit-id="hauler"]')?.getAttribute('aria-pressed'),
      joined: Boolean(gc?.getNetworkManager?.()?.getLocalPlayerId?.()),
      connected: Boolean(gc?.getNetworkManager?.()?.isConnected),
      startX: player?.ship?.position?.x,
      startY: player?.ship?.position?.y,
    };
  });
  expect(before.kitId).toBe('hauler');
  expect(before.selected).toBe('true');
  expect(before.joined).toBe(true);

  const flyDeadline = Date.now() + 9000;
  let lastNav: Record<string, unknown> = {};
  let startGap = Number.POSITIVE_INFINITY;
  while (Date.now() < flyDeadline) {
    const nav = await page.evaluate(() => {
      const gc = (window as { gameController?: any }).gameController;
      const ship = gc?.playerManager?.getLocalPlayer?.()?.ship;
      const roids = gc?.getCurrRoidBelt?.()?.getRoids?.() ?? [];
      if (!ship || !roids.length) {
        return { ok: false, reason: 'missing ship or rock' };
      }
      const rock = roids
        .map((candidate: { position: { x: number; y: number }; r?: number; id?: string }) => ({
          candidate,
          dist: Math.hypot(
            candidate.position.x - ship.position.x,
            candidate.position.y - ship.position.y
          ),
        }))
        .sort((a: { dist: number }, b: { dist: number }) => a.dist - b.dist)[0]?.candidate;
      if (!rock) {
        return { ok: false, reason: 'no rock' };
      }
      const dx = rock.position.x - ship.position.x;
      const dy = rock.position.y - ship.position.y;
      const dist = Math.hypot(dx, dy);
      const gap = dist - (ship.r ?? 0) - (rock.r ?? 0);
      const desired = Math.atan2(-dy, dx);
      let delta = desired - ship.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return {
        ok: true,
        kitId: ship.kitId,
        gap,
        dist,
        delta,
        rockId: rock.id ?? null,
        x: ship.position.x,
        y: ship.position.y,
      };
    });
    lastNav = nav;
    if (startGap === Number.POSITIVE_INFINITY && typeof nav.gap === 'number') {
      startGap = nav.gap;
    }
    if (!nav.ok) {
      break;
    }
    if ((nav.gap ?? 9999) < 90) {
      break;
    }
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyD');
    const delta = nav.delta ?? 0;
    if (delta > 0.12) {
      await page.keyboard.down('KeyA');
    } else if (delta < -0.12) {
      await page.keyboard.down('KeyD');
    }
    if (Math.abs(delta) < 0.55) {
      await page.keyboard.down('KeyW');
    } else {
      await page.keyboard.up('KeyW');
    }
    await page.waitForTimeout(50);
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyD');

  const afterFly = await page.evaluate((start: { x: number; y: number }) => {
    const gc = (window as { gameController?: any }).gameController;
    const ship = gc?.playerManager?.getLocalPlayer?.()?.ship;
    const moved = Math.hypot(ship.position.x - start.x, ship.position.y - start.y);
    return { moved, kitId: ship?.kitId, x: ship?.position?.x, y: ship?.position?.y };
  }, { x: before.startX, y: before.startY });
  expect(afterFly.kitId).toBe('hauler');
  expect(lastNav.ok).toBe(true);
  // Already hull-close at join: do not require a fake cruise. Far rocks must move via WASD.
  if (startGap >= 90) {
    expect(afterFly.moved).toBeGreaterThan(8);
  }

  await page.keyboard.press('e');

  const frames: Array<Record<string, unknown>> = [];
  const sampleDeadline = Date.now() + 1000;
  while (Date.now() < sampleDeadline) {
    const sample = await page.evaluate((colors: { cream: string; tip: string }) => {
      const gc = (window as { gameController?: any }).gameController;
      gc?.renderGame?.();
      const ship = gc?.playerManager?.getLocalPlayer?.()?.ship;
      const probe = gc?.diagnoseHarpoon?.();
      const canvas = document.querySelector('#gameCanvas') as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      const pixels = ctx && canvas ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
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
    }, { cream: CREAM, tip: TIP });
    frames.push(sample);
    if (sample.cream && sample.tip && (sample.harpoonTimer as number) > 0) {
      break;
    }
    await page.waitForTimeout(16);
  }

  const best = [...frames].reverse().find((frame) => frame.cream && frame.tip) ?? frames.at(-1);
  // eslint-disable-next-line no-console
  console.log('[hauler-smoke]', JSON.stringify({ lastNav, afterFly, frames: frames.length, best }));

  expect(best?.kitId).toBe('hauler');
  expect(best?.harpoonTimer).toBeGreaterThan(0);
  expect(best?.findTarget || best?.latchPos).toBeTruthy();
  expect(best?.cream).toBe(true);
  expect(best?.tip).toBe(true);

  await page.screenshot({ path: screenshotManager.getScreenshotPath(`hauler-${viewport}-live-tether.png`) });
  const flap = await page.evaluate(async () => {
    const gc = (window as { gameController?: any }).gameController;
    const connection = gc.getNetworkManager().connectionManager;
    const ship = gc.playerManager.getLocalPlayer().ship;
    const socket: WebSocket = connection.state.socket;
    const targetId = ship.harpoonTargetId;
    const startedAt = Date.now();
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    socket.close(4000, 'Browser regression: brief connection flap');
    await closed;
    return {
      startedAt,
      targetId,
      timer: ship.harpoonTimer,
      rocks: gc.getCurrRoidBelt().getRoids().length,
      health: ship.health,
      lives: gc.playerManager.getLocalPlayer().lives,
    };
  });
  expect(flap.timer).toBeGreaterThan(0);
  expect(flap.rocks).toBeGreaterThan(0);
  const reconnectWaitStartedAt = Date.now();
  await page.waitForFunction(() => {
    const gc = (window as { gameController?: any }).gameController;
    const connection = gc?.getNetworkManager?.().connectionManager;
    return connection?.state.isConnected && connection.hasInitializedAsteroidsForConnection;
  }, undefined, { timeout: 2500 });
  const reconnectedAt = Date.now();
  // Let the newly joined connection receive authoritative game-state frames.
  await page.waitForTimeout(80);
  const resumed = await page.evaluate(() => {
    const gc = (window as { gameController?: any }).gameController;
    const ship = gc.playerManager.getLocalPlayer().ship;
    const targetId = ship.harpoonTargetId;
    const rocks = gc.getCurrRoidBelt().getRoids();
    return {
      targetId,
      timer: ship.harpoonTimer,
      rocks: rocks.map((rock: { id: string }) => rock.id).sort(),
      targetInField: rocks.some((rock: { id: string }) => rock.id === targetId),
      health: ship.health,
      lives: gc.playerManager.getLocalPlayer().lives,
      connected: Boolean(gc.getNetworkManager()?.isConnected),
    };
  });
  // eslint-disable-next-line no-console
  console.log('[hauler-reconnect]', JSON.stringify({
    viewport,
    flap,
    reconnectWaitMs: reconnectedAt - reconnectWaitStartedAt,
    postReconnectMs: Date.now() - reconnectedAt,
    resumed,
  }));
  expect(resumed.timer).toBeGreaterThan(0);
  expect(resumed.targetId).toBe(flap.targetId);
  expect(resumed.rocks.length).toBeGreaterThan(0);
  const peerRocks = (await peer.getAsteroidPositions()).map((rock) => rock.id).sort();
  expect(resumed.rocks).toEqual(peerRocks);
  await page.screenshot({ path: screenshotManager.getScreenshotPath(`hauler-${viewport}-after-reconnect.png`) });
  expect(consoleErrors).toEqual([]);
}, TestConfig.DEFAULT_TIMEOUT);
