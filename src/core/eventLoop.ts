import { noteDebugFrame } from '../diagnostics/debugHudMetrics';
import { clientPerformance } from '../diagnostics/performanceMetrics';

export interface EventLoopLifecycle {
  getIsGameRunning(): boolean;
  getCurrPlayer(): { ship: { exploding: boolean } } | null | undefined;
  resetPresentationClock(): void;
  updateGame(dtMs: number): void;
  renderGame(): void;
  stopAfterFrameFailure(): void;
  getNetworkManager(): {
    readonly isConnected: boolean;
    sendMessage(message: { type: 'snapshotResync'; data: Record<string, never> }): boolean;
  };
}

export interface EventLoopHost {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'hidden' | 'body'>;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  now(): number;
  observeRenderer?(): void;
  present?(now: number): void;
  reportFailure(error: unknown): void;
}

export class EventLoop {
  private disposed = false;
  private gameLoopScheduled = false;
  private presentationReset = false;
  private hiddenAt: number | undefined;
  private lastTime = 0;
  private pendingFrame: number | undefined;

  constructor(
    private readonly lifecycle: EventLoopLifecycle,
    private readonly host: EventLoopHost
  ) {
    host.document.addEventListener('visibilitychange', this.visibilityChanged);
    host.window.addEventListener('gameStart', this.start);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.gameLoopScheduled = false;
    if (this.pendingFrame !== undefined) {
      this.host.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = undefined;
    }
    this.host.document.removeEventListener('visibilitychange', this.visibilityChanged);
    this.host.window.removeEventListener('gameStart', this.start);
  }

  private readonly visibilityChanged = (): void => {
    if (this.disposed) {
      return;
    }
    this.presentationReset = true;
    if (this.host.document.hidden) {
      this.hiddenAt = this.host.now();
      clientPerformance.setPhase('hidden');
      clientPerformance.count('hiddenPeriods');
    } else if (this.lifecycle.getIsGameRunning()) {
      if (this.hiddenAt !== undefined) {
        clientPerformance.record('hiddenDurationMs', this.host.now() - this.hiddenAt);
      }
      this.hiddenAt = undefined;
      this.lifecycle.resetPresentationClock();
      clientPerformance.recover(this.host.now());
      const network = this.lifecycle.getNetworkManager();
      if (network.isConnected && network.sendMessage({ type: 'snapshotResync', data: {} })) {
        clientPerformance.count('resyncs');
      }
    }
  };

  private readonly start = (): void => {
    if (this.disposed || this.gameLoopScheduled) {
      return;
    }
    this.gameLoopScheduled = true;
    this.lastTime = this.host.now();
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (!this.disposed && this.gameLoopScheduled && this.pendingFrame === undefined) {
      this.pendingFrame = this.host.requestAnimationFrame(this.frame);
    }
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) {
      return;
    }
    this.pendingFrame = undefined;
    if (!this.lifecycle.getIsGameRunning()) {
      clientPerformance.setPhase('menu');
      this.gameLoopScheduled = false;
      return;
    }
    try {
      const dtMs = this.presentationReset ? 0 : now - this.lastTime;
      this.presentationReset = false;
      this.lastTime = now;
      if (this.host.document.hidden) {
        this.scheduleFrame();
        return;
      }
      const observing = clientPerformance.enabled;
      const debugHudOn = this.host.document.body.classList.contains('debug-on');
      if (observing) {
        clientPerformance.setPhase(
          this.host.document.hidden
            ? 'hidden'
            : this.lifecycle.getCurrPlayer()?.ship.exploding
              ? 'respawn'
              : 'play'
        );
        clientPerformance.record('frameIntervalMs', dtMs);
      }
      if (debugHudOn) {
        noteDebugFrame(dtMs);
      }
      const started = observing ? this.host.now() : 0;
      this.lifecycle.updateGame(dtMs);
      if (this.disposed) {
        return;
      }
      const updated = observing ? this.host.now() : 0;

      // Then render the current game state
      this.lifecycle.renderGame();
      if (this.disposed) {
        return;
      }
      if (observing) {
        const rendered = this.host.now();
        clientPerformance.record('updateMs', updated - started);
        clientPerformance.record('renderMs', rendered - updated);
        clientPerformance.record('frameCpuMs', rendered - started);
        clientPerformance.rendered(rendered);
        this.host.observeRenderer?.();
        clientPerformance.exportIfDue(rendered);
      }
      this.host.present?.(now);
      this.scheduleFrame();
    } catch (error) {
      this.gameLoopScheduled = false;
      clientPerformance.count('frameFailures');
      this.lifecycle.stopAfterFrameFailure();
      this.host.reportFailure(error);
    }
  };
}
