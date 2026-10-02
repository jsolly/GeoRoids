import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { SnapshotDecoder } from '../../shared/snapshotProtocol';
import type { ServerGameSnapshot } from '../../shared-types';
import { PALETTE, VISUAL } from '../../src/constants';
import { hexToRgba } from '../../src/utils/colorUtils';

const GAMEPLAY_SOCKET = /\/ws(?:\?|$)/u;
type Surface = typeof import('../../src/rendering/canvasSurface').canvasManager;

/** Observe real server admission, separately from the client's predicted lasers. */
export function watchGpuPilotSnapshots(page: Page) {
  let latest: ServerGameSnapshot | undefined;
  let snapshots = 0;
  let connections = 0;
  let closedConnections = 0;
  const shots = new Map<string, string>();
  const errors: string[] = [];
  page.on('websocket', (socket) => {
    if (!GAMEPLAY_SOCKET.test(socket.url())) {
      return;
    }
    connections++;
    const decoder = new SnapshotDecoder();
    socket.on('close', () => closedConnections++);
    socket.on('framereceived', ({ payload }) => {
      try {
        const result = decoder.readMessage(String(payload), { acceptSnapshots: true });
        if (result.kind === 'snapshot-rejected') {
          throw result.error;
        }
        if (result.kind === 'message') {
          if (
            result.message &&
            typeof result.message === 'object' &&
            'type' in result.message &&
            result.message.type === 'joined'
          ) {
            decoder.reset();
          }
          return;
        }
        latest = result.state;
        snapshots++;
        for (const projectile of latest.playerProjectiles) {
          shots.set(projectile.id, projectile.ownerId);
        }
        // The scenario offers a handful of shots; retain bounded historical admission.
        assert(shots.size <= 512, 'GPU scenario exceeded its bounded shot witness');
      } catch (error) {
        errors.push(String(error));
      }
    });
  });
  return {
    read: () => ({
      snapshots,
      connections,
      closedConnections,
      gameTime: latest?.gameTime,
      errors: [...errors],
    }),
    position: (id: string) => {
      const entity = latest?.entities.find((row) => row.id === id);
      return entity ? { ...entity.position } : undefined;
    },
    shots: (id: string) =>
      new Set([...shots].filter(([, owner]) => owner === id).map(([shot]) => shot)),
  };
}

/** Wrap executed game drawing without scheduling or invoking another game frame. */
export async function observeGpuGameDrawing(page: Page) {
  const surface = await page.evaluateHandle<Surface>(
    "import('/src/rendering/canvasSurface.ts').then(module => module.canvasManager)"
  );
  try {
    return await surface.evaluateHandle(
      (canvas, inks) => {
        const controller = window.gameController;
        const ctx = canvas.requireContext();
        const overlay = canvas.requireCanvas();
        const gpu = document.querySelector('#gameGpuCanvas');
        if (!controller || !(gpu instanceof HTMLCanvasElement)) {
          throw new Error('Missing joined GPU playfield');
        }
        const extension = gpu.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) {
          throw new Error('Missing native context-loss extension');
        }
        const colors = document.createElement('canvas').getContext('2d');
        if (!colors) {
          throw new Error('Missing native color normalizer');
        }
        const normalize = (ink: string) => {
          colors.fillStyle = ink;
          return colors.fillStyle;
        };
        const background = normalize(inks.background);
        const hud = normalize(inks.hud);
        const contours = inks.contours.map(normalize);
        const counters = {
          renders: 0,
          opaqueBackgrounds: 0,
          contourPaths: 0,
          bankLabels: 0,
          hiddenEvents: 0,
          freezeEvents: 0,
          resumeEvents: 0,
          rendersAtFreeze: 0,
          rendersAtResume: 0,
          rafObservedRenders: 0,
          duplicateFrameTimestamps: 0,
        };
        let drawing = false;
        let activeFrameTimestamp: number | null = null;
        let previousRenderTimestamp: number | null = null;
        const requestFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback) =>
          requestFrame.call(window, (timestamp) => {
            const previous = activeFrameTimestamp;
            activeFrameTimestamp = timestamp;
            try {
              callback(timestamp);
            } finally {
              activeFrameTimestamp = previous;
            }
          });
        const render = controller.renderGame;
        const fillRect = ctx.fillRect;
        const stroke = ctx.stroke;
        const fillText = ctx.fillText;
        const visibility = () => {
          if (document.visibilityState === 'hidden') {
            counters.hiddenEvents++;
          }
        };
        // Snapshot the actual transition boundaries; protocol acknowledgment and
        // debugger evaluation can precede delivery of the renderer's freeze event.
        const freeze = () => {
          counters.freezeEvents++;
          counters.rendersAtFreeze = counters.renders;
        };
        const resume = () => {
          counters.resumeEvents++;
          counters.rendersAtResume = counters.renders;
        };
        document.addEventListener('visibilitychange', visibility);
        document.addEventListener('freeze', freeze);
        document.addEventListener('resume', resume);
        controller.renderGame = () => {
          counters.renders++;
          if (activeFrameTimestamp !== null) {
            counters.rafObservedRenders++;
            if (activeFrameTimestamp === previousRenderTimestamp) {
              counters.duplicateFrameTimestamps++;
            }
            previousRenderTimestamp = activeFrameTimestamp;
          }
          drawing = true;
          try {
            render.call(controller);
          } finally {
            drawing = false;
          }
        };
        ctx.fillRect = function (this: CanvasRenderingContext2D, x, y, width, height) {
          const transform = this.getTransform();
          if (
            drawing &&
            x === 0 &&
            y === 0 &&
            width === overlay.width &&
            height === overlay.height &&
            transform.isIdentity &&
            this.fillStyle === background &&
            this.globalAlpha === 1 &&
            this.globalCompositeOperation === 'source-over'
          ) {
            counters.opaqueBackgrounds++;
          }
          fillRect.call(this, x, y, width, height);
        };
        ctx.stroke = function (this: CanvasRenderingContext2D, path?: Path2D) {
          if (
            drawing &&
            path instanceof Path2D &&
            typeof this.strokeStyle === 'string' &&
            contours.includes(this.strokeStyle) &&
            this.shadowBlur === 0 &&
            this.lineCap === 'round'
          ) {
            counters.contourPaths++;
          }
          Reflect.apply(stroke, this, path ? [path] : []);
        };
        ctx.fillText = function (this: CanvasRenderingContext2D, text, x, y, maxWidth?) {
          if (drawing && text.startsWith('Bank ') && this.fillStyle === hud) {
            counters.bankLabels++;
          }
          if (maxWidth === undefined) {
            fillText.call(this, text, x, y);
          } else {
            fillText.call(this, text, x, y, maxWidth);
          }
        };
        return {
          lose: () => extension.loseContext(),
          restoreContext: () => extension.restoreContext(),
          read: () => {
            const report = window.georoidsPerformance?.read();
            return {
              ...counters,
              backend: canvas.getRendererBackend(),
              stats: canvas.getGpuFrameStats(),
              sameOwner:
                window.gameController === controller &&
                canvas.requireCanvas() === overlay &&
                document.querySelector('#gameGpuCanvas') === gpu,
              gpuCanvases: document.querySelectorAll('#gameGpuCanvas').length,
              opaqueContext: ctx.getContextAttributes().alpha === false,
              css: { width: overlay.clientWidth, height: overlay.clientHeight },
              backing: {
                width: overlay.width,
                height: overlay.height,
                gpuWidth: gpu.width,
                gpuHeight: gpu.height,
              },
              frameCpuCount: Object.entries(report?.metrics ?? {})
                .filter(([name]) => name.endsWith('.frameCpuMs'))
                .reduce((sum, [, metric]) => sum + metric.count, 0),
              renderer: report?.renderer,
              counters: report?.counters,
            };
          },
          cleanup: () => {
            window.requestAnimationFrame = requestFrame;
            controller.renderGame = render;
            ctx.fillRect = fillRect;
            ctx.stroke = stroke;
            ctx.fillText = fillText;
            document.removeEventListener('visibilitychange', visibility);
            document.removeEventListener('freeze', freeze);
            document.removeEventListener('resume', resume);
          },
        };
      },
      {
        background: PALETTE.BG,
        hud: PALETTE.HUD,
        contours: [
          hexToRgba(PALETTE.CONTOUR, VISUAL.CONTOUR_ALPHA),
          hexToRgba(PALETTE.CONTOUR, VISUAL.CONTOUR_INDEX_ALPHA),
        ],
      }
    );
  } finally {
    await surface.dispose();
  }
}
