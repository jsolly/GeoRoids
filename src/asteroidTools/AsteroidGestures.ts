import type { Position } from '../../shared-types';
import type { AsteroidToolsController, AsteroidToolsMotionAction } from './AsteroidToolsController';

type Gesture = { id: number; x: number; y: number; targetId: string | undefined };

/** A second playfield touch handles asteroid gestures while the first steers. */
export class AsteroidGestures {
  private gesture: Gesture | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly controller: AsteroidToolsController,
    private readonly options: {
      isPlaying: () => boolean;
      project: (position: Position) => { x: number; y: number; scale: number } | undefined;
    }
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.cancel);
    canvas.addEventListener('lostpointercapture', this.cancel);
    window.addEventListener('blur', this.cancel);
    window.addEventListener('pagehide', this.cancel);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  cancel = (event?: Event): void => {
    if (event && 'pointerId' in event && event.pointerId !== this.gesture?.id) {
      return;
    }
    const gesture = this.gesture;
    this.gesture = undefined;
    if (gesture && this.canvas.hasPointerCapture(gesture.id)) {
      this.canvas.releasePointerCapture(gesture.id);
    }
  };

  dispose(): void {
    this.cancel();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.cancel);
    this.canvas.removeEventListener('lostpointercapture', this.cancel);
    window.removeEventListener('blur', this.cancel);
    window.removeEventListener('pagehide', this.cancel);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.cancel();
    }
  };

  private onDown = (event: PointerEvent): void => {
    if (
      event.defaultPrevented ||
      this.gesture ||
      !this.options.isPlaying() ||
      (event.pointerType === 'mouse' && event.button !== 1)
    ) {
      return;
    }
    const state = this.controller.getState();
    if (!state.pilot || state.pilot.alive === false) {
      return;
    }
    let targetId: string | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const target of state.targets) {
      const point = this.options.project(target.position);
      if (!point) {
        continue;
      }
      const distance = Math.hypot(event.clientX - point.x, event.clientY - point.y);
      if (distance <= Math.max(24, target.size * point.scale) && distance < nearest) {
        nearest = distance;
        targetId = target.id;
      }
    }
    event.preventDefault();
    this.gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, targetId };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.id) {
      return;
    }
    event.preventDefault();
    this.cancel();
    const pilot = this.controller.getState().pilot;
    if (!this.options.isPlaying() || !pilot || pilot.alive === false) {
      return;
    }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) >= 40) {
      const action: AsteroidToolsMotionAction =
        Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'brake' : 'spin') : dy > 0 ? 'release' : 'anchor';
      if (gesture.targetId) {
        this.controller.selectTarget(gesture.targetId);
      }
      this.controller.requestMotion(action);
    } else if (gesture.targetId && this.controller.selectTarget(gesture.targetId)) {
      const motion = this.controller.getState().pilot?.asteroidMotion;
      this.controller.requestMotion(motion?.mode === 'latched' ? 'anchor' : 'latch');
    } else {
      this.controller.selectTarget(undefined);
    }
  };
}
