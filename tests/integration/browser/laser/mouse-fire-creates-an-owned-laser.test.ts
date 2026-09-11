import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { centerOf } from '../../utils/touch-input';
import { localPlayerId, observeLaser, parkLaserClient } from './laser-observation';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();

/** Observe the real animation loop and real core strokes while the shoot packet is in flight. */
async function paintedShotFrames(page: Page) {
  return page.evaluate(async () => {
    const original = CanvasRenderingContext2D.prototype.stroke;
    const originalMoveTo = CanvasRenderingContext2D.prototype.moveTo;
    const originalLineTo = CanvasRenderingContext2D.prototype.lineTo;
    let from = { x: 0, y: 0 };
    let to = { x: 0, y: 0 };
    CanvasRenderingContext2D.prototype.moveTo = function (x: number, y: number) {
      from = { x, y };
      originalMoveTo.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.lineTo = function (x: number, y: number) {
      to = { x, y };
      originalLineTo.call(this, x, y);
    };
    let painted = 0;
    let started = false;
    let raf = 0;
    const frames: Array<{ count: number; painted: number; x: number; y: number }> = [];
    CanvasRenderingContext2D.prototype.stroke = function (
      this: CanvasRenderingContext2D,
      path?: Path2D
    ) {
      if (
        this.canvas.id === 'gameCanvas' &&
        this.strokeStyle === '#fde68a' &&
        this.lineWidth === 2
      ) {
        const ship = window.gameController?.getPlayerManager().getLocalShip();
        const shot = ship?.lasers[0];
        if (ship && shot) {
          const x = innerWidth / 2 + shot.position.x - ship.position.x;
          const y = innerHeight / 2 + shot.position.y - ship.position.y;
          if (
            Math.hypot((from.x + to.x) / 2 - x, (from.y + to.y) / 2 - y) < 0.01 &&
            Math.abs(Math.hypot(to.x - from.x, to.y - from.y) - 15) < 0.01
          ) {
            painted++;
          }
        }
      }
      Reflect.apply(original, this, path ? [path] : []);
    };
    let deadline = 0;
    try {
      return await new Promise<typeof frames>((resolve, reject) => {
        deadline = window.setTimeout(() => reject(new Error('No painted local shot')), 5000);
        const sample = () => {
          const ship = window.gameController?.getPlayerManager().getLocalShip();
          const shot = ship?.lasers[0];
          if (shot) {
            started = true;
          }
          if (started) {
            frames.push({
              count: ship?.lasers.length ?? 0,
              painted,
              x: shot?.position.x ?? NaN,
              y: shot?.position.y ?? NaN,
            });
          }
          painted = 0;
          if (frames.length === 12) {
            resolve(frames);
          } else {
            raf = requestAnimationFrame(sample);
          }
        };
        raf = requestAnimationFrame(sample);
      });
    } finally {
      clearTimeout(deadline);
      cancelAnimationFrame(raf);
      CanvasRenderingContext2D.prototype.stroke = original;
      CanvasRenderingContext2D.prototype.moveTo = originalMoveTo;
      CanvasRenderingContext2D.prototype.lineTo = originalLineTo;
    }
  });
}

for (const touch of [false, true]) {
  test(
    `${touch ? 'touch Fire' : 'a mouse click'} keeps one painted local bolt through delayed server acknowledgement`,
    async () => {
      const page = touch
        ? await browserManager.recreatePage({ hasTouch: true })
        : browserManager.getCurrentPage();
      if (!page) {
        throw new Error('Page not available');
      }
      await page.setViewportSize(
        touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }
      );
      const consoleProblems: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') {
          consoleProblems.push(`${message.type()}: ${message.text()}`);
        }
      });
      const delayedShots: Array<() => void> = [];
      let holdShots = true;
      let snapshots = 0;
      await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const packet = JSON.parse(String(message));
          if (holdShots && packet.type === 'shoot') {
            delayedShots.push(() => server.send(message));
          } else {
            server.send(message);
          }
        });
        server.onMessage((message) => {
          if (JSON.parse(String(message)).type === 'snapshot') {
            snapshots++;
          }
          socket.send(message);
        });
      });
      const game = new GameInteractions(page);
      await game.bootGame({ waitForCombatReady: false });
      await parkLaserClient(game);
      await game.waitForCombatReady();
      expect(await game.getLaserCount()).toBe(0);
      const shooterId = await localPlayerId(page);
      const snapshotsBefore = snapshots;
      const rendering = paintedShotFrames(page);
      const observation = observeLaser(page, shooterId, false, true);
      try {
        if (touch) {
          const fire = await centerOf(page, '#touch-fire');
          await page.touchscreen.tap(fire.x, fire.y);
        } else {
          await page.mouse.click(640, 450);
        }
        const [frames, shot] = await Promise.all([rendering, observation]);
        expect(shot.ownerId).toBe(shooterId);
        expect(Math.hypot(shot.vx, shot.vy)).toBeGreaterThan(0);
        expect(delayedShots).toHaveLength(1);
        expect(snapshots - snapshotsBefore).toBeGreaterThan(1);
        for (const frame of frames) {
          expect(frame.count).toBe(1);
          expect(frame.painted).toBeGreaterThan(0);
        }
        const first = frames[0];
        const last = frames.at(-1);
        if (!first || !last) {
          throw new Error('Shot frames are missing');
        }
        expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(10);
        await page.screenshot({
          path: screenshotManager.getScreenshotPath(
            `local-shot-${touch ? 'mobile' : 'desktop'}.png`
          ),
        });
        holdShots = false;
        for (const send of delayedShots.splice(0)) {
          send();
        }
        await page.waitForFunction(() => {
          const shots = window.gameController?.getPlayerManager().getLocalShip()?.lasers;
          return shots?.length === 1 && !!shots[0]?.serverId;
        });
        expect(consoleProblems).toEqual([]);
      } finally {
        holdShots = false;
        for (const send of delayedShots.splice(0)) {
          send();
        }
        await Promise.allSettled([rendering, observation]);
      }
    },
    TestConfig.DEFAULT_TIMEOUT
  );
}
