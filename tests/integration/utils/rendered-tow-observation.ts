import type { Page } from 'playwright';
import type { TowLifecycle } from '../../support/towLifecycle';

/** Observe ordinary canvas work without changing game state or its running clock. */
export async function observeRenderedTow(
  page: Page,
  selection: ConstructorParameters<typeof TowLifecycle>[0]
) {
  // Browser strings avoid Vitest's server-only dynamic-import transformation.
  const module = await page.evaluateHandle<typeof import('../../support/towLifecycle')>(
    "import('/tests/support/towLifecycle.ts')"
  );
  try {
    return await module.evaluateHandle(({ TowLifecycle: Lifecycle }, selected) => {
      const canvas = document.querySelector('#gameCanvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Tow observation requires the game canvas');
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Tow observation requires its native drawing context');
      }
      const lifecycle = new Lifecycle(selected);
      let attachmentImage: string | null = null;
      let failure: string | null = null;
      let stopped = false;
      let frame = 0;
      const sample = () => {
        const player = window.gameController?.getCurrPlayer();
        if (!player) {
          throw new Error('Tow observation lost its pilot');
        }
        return {
          pilotId: player.id,
          epoch: player.ship.playerMotion?.epoch,
          targetId: player.ship.harpoonTargetId,
          health: player.ship.health,
          exploding: player.ship.exploding,
          inTransit: Boolean(player.ship.furnaceTransit),
          at: performance.now(),
        };
      };
      const record = (drawn = false) => {
        try {
          lifecycle.observe(sample(), drawn);
        } catch (error) {
          failure ??= error instanceof Error ? error.message : String(error);
        }
      };
      const stroke = ctx.stroke;
      const drawStroke = stroke.bind(ctx);
      const observedStroke: typeof ctx.stroke = function (
        this: CanvasRenderingContext2D,
        path?: Path2D
      ): void {
        if (path === undefined) {
          drawStroke();
        } else {
          drawStroke(path);
        }
        try {
          const ship = window.gameController?.getCurrPlayer()?.ship;
          // Outbound utility lines share this color; they cannot prove attachment.
          if (
            !stopped &&
            ship?.harpoonTargetId === selected.targetId &&
            !ship.utilityFlight &&
            this.strokeStyle === '#e8d5a3' &&
            this.lineWidth === 1.5
          ) {
            record(true);
            attachmentImage ??= canvas.toDataURL('image/png');
          }
        } catch (error) {
          failure ??= error instanceof Error ? error.message : String(error);
        }
      };
      ctx.stroke = observedStroke;
      const observeFrame = () => {
        if (stopped) {
          return;
        }
        record();
        frame = requestAnimationFrame(observeFrame);
      };
      observeFrame();
      return {
        read: () => {
          record();
          if (failure !== null) {
            throw new Error(failure);
          }
          const state = lifecycle.snapshot();
          if (state.failure !== null) {
            throw new Error(state.failure);
          }
          return state;
        },
        evidence: () => {
          record();
          return { ...lifecycle.snapshot(), captureFailure: failure };
        },
        image: () => attachmentImage,
        stop: () => {
          stopped = true;
          cancelAnimationFrame(frame);
          const failures: unknown[] = [];
          if (ctx.stroke !== observedStroke) {
            failures.push(new Error('Tow canvas observer was replaced before cleanup'));
          } else {
            ctx.stroke = stroke;
          }
          record();
          if (failure !== null) {
            failures.push(new Error(failure));
          }
          try {
            lifecycle.finish();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Tow observation finalization failed');
          }
        },
      };
    }, selection);
  } finally {
    await module.dispose();
  }
}
