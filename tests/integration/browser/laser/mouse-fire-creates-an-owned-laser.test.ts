import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { VISUAL } from '../../../../src/constants';
import { PLAYFIELD_CLOSE_SCALE } from '../../../../src/rendering/playfieldCamera';
import { createBrowserScenarioHooks } from '../../utils/browser-scenario-setup';
import { GameInteractions } from '../../utils/game-interactions';
import { TestConfig } from '../../utils/test-config';
import { canvasPoint } from '../../utils/touch-input';
import { localPlayerId, observeLaser, parkLaserClient } from './laser-observation';

const { browserManager, screenshotManager } = createBrowserScenarioHooks();
const WS_PATH_PATTERN = /\/ws(?:\?|$)/u;

/** Observe actual cached-bolt draws while the shoot packet is in flight. */
function paintedShotFrames(page: Page) {
  return page.evaluate(
    async ({ coreColor, playfieldScale }) => {
      const original = CanvasRenderingContext2D.prototype.drawImage;
      const coreMatches = new WeakMap<HTMLCanvasElement, boolean>();
      let painted = 0;
      let started = false;
      let raf = 0;
      const frames: Array<{ count: number; painted: number; x: number; y: number }> = [];
      CanvasRenderingContext2D.prototype.drawImage = function (
        this: CanvasRenderingContext2D,
        source: CanvasImageSource,
        ...coordinates: number[]
      ) {
        Reflect.apply(original, this, [source, ...coordinates]);
        const ship = window.gameController?.getPlayerManager().getLocalShip();
        const shot = ship?.lasers[0];
        if (
          this.canvas.id !== 'gameCanvas' ||
          !(source instanceof HTMLCanvasElement) ||
          coordinates.length !== 4 ||
          !ship ||
          !shot
        ) {
          return;
        }
        const [dx, dy, width, height] = coordinates;
        if (dx === undefined || dy === undefined || !width || !height) {
          return;
        }
        const transform = this.getTransform();
        const dpr = Math.hypot(transform.a, transform.b);
        const rect = this.canvas.getBoundingClientRect();
        const x = rect.width / 2 + (shot.position.x - ship.position.x) * playfieldScale;
        const y = rect.height / 2 + (shot.position.y - ship.position.y) * playfieldScale;
        if (Math.hypot(transform.e / dpr - x, transform.f / dpr - y) >= 0.01) {
          return;
        }
        // The sprite origin is the bolt center. Verify its opaque core, not
        // merely any image drawn at the predicted projectile position.
        if (!coreMatches.has(source)) {
          const pixel = source
            .getContext('2d')
            ?.getImageData(
              Math.round((-dx * source.width) / width),
              Math.round((-dy * source.height) / height),
              1,
              1
            ).data;
          coreMatches.set(
            source,
            Boolean(
              pixel &&
                pixel[0] === coreColor[0] &&
                pixel[1] === coreColor[1] &&
                pixel[2] === coreColor[2] &&
                pixel[3] === 255
            )
          );
        }
        if (coreMatches.get(source)) {
          painted++;
        }
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
        CanvasRenderingContext2D.prototype.drawImage = original;
      }
    },
    {
      coreColor: [1, 3, 5].map((offset) =>
        Number.parseInt(VISUAL.LASER_CORE_COLOR.slice(offset, offset + 2), 16)
      ),
      playfieldScale: PLAYFIELD_CLOSE_SCALE,
    }
  );
}

for (const touch of [false, true]) {
  test(
    `${touch ? 'a canvas touch' : 'a mouse click'} keeps one painted local bolt through delayed server acknowledgement`,
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
      await page.routeWebSocket(WS_PATH_PATTERN, (socket) => {
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
          const firePoint = await canvasPoint(page, 0.75, 0.5);
          await page.touchscreen.tap(firePoint.x, firePoint.y);
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
          return shots?.length === 1 && Boolean(shots[0]?.serverId);
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
