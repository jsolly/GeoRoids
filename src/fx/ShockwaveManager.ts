import type { Position } from '../../shared-types';
import {
  framesToMs,
  SHOCKWAVE_WAVES,
  type ShockwaveWaveSpec,
  shockwaveLifetimeMs,
} from '../physics/shockwave';

type ActiveShockwave = {
  origin: Position;
  startedAt: number;
  fired: Set<string>;
};

type ShockwaveFireHandler = (origin: Position, wave: ShockwaveWaveSpec) => void;

/**
 * Client-side double-wave tracker. Visuals are time-based so they stay
 * locked to the 60 FPS wave spec even when the render loop is rAF.
 */
export class ShockwaveManager {
  private static instance: ShockwaveManager;
  private active: ActiveShockwave[] = [];
  private onWaveFire: ShockwaveFireHandler | null = null;

  static getInstance(): ShockwaveManager {
    if (!ShockwaveManager.instance) {
      ShockwaveManager.instance = new ShockwaveManager();
    }
    return ShockwaveManager.instance;
  }

  setWaveFireHandler(handler: ShockwaveFireHandler | null): void {
    this.onWaveFire = handler;
  }

  spawn(origin: Position, now = performance.now()): ActiveShockwave {
    const fx: ActiveShockwave = {
      origin: { x: origin.x, y: origin.y },
      startedAt: now,
      fired: new Set(),
    };
    this.fireDue(fx, now);
    this.active.push(fx);
    return fx;
  }

  update(now = performance.now()): void {
    const lifetime = shockwaveLifetimeMs();
    for (const fx of this.active) {
      this.fireDue(fx, now);
    }
    this.active = this.active.filter((fx) => now - fx.startedAt <= lifetime);
  }

  getActive(now = performance.now()): ActiveShockwave[] {
    const lifetime = shockwaveLifetimeMs();
    return this.active.filter((fx) => now - fx.startedAt <= lifetime);
  }

  getDebugState(now = performance.now()): {
    count: number;
    lifetimeMs: number;
    now: number;
    items: Array<{ ageMs: number; fired: string[] }>;
  } {
    return {
      count: this.active.length,
      lifetimeMs: shockwaveLifetimeMs(),
      now,
      items: this.active.map((fx) => ({
        ageMs: now - fx.startedAt,
        fired: [...fx.fired],
      })),
    };
  }

  clear(): void {
    this.active = [];
  }

  private fireDue(fx: ActiveShockwave, now: number): void {
    const ageMs = now - fx.startedAt;
    for (const wave of SHOCKWAVE_WAVES) {
      const delayMs = framesToMs(wave.delayFrames);
      if (ageMs + 0.0001 >= delayMs && !fx.fired.has(wave.id)) {
        fx.fired.add(wave.id);
        this.onWaveFire?.(fx.origin, wave);
      }
    }
  }
}

export const shockwaveManager = ShockwaveManager.getInstance();
