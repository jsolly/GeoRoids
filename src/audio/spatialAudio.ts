import type { Position } from '../../shared-types';
import { AUDIO } from '../constants';
import { soundIsOn } from '../constants/user-preferences';
import { getDistance } from '../utils/mathUtils';
import { playSound, type Sound } from './Sound';

type ViewportSize = { width: number; height: number };

interface PlaybackPlan {
  shouldPlay: boolean;
  volumeScale: number;
}

type ListenerProvider = () => Position | undefined;
type ViewportProvider = () => ViewportSize | undefined;

let getListenerPosition: ListenerProvider = () => undefined;
let getViewportSize: ViewportProvider = () => undefined;
const resetHooks: Array<() => void> = [];

export function registerAudioResetHook(hook: () => void): void {
  resetHooks.push(hook);
}

export function bindGameAudio(options: {
  getListenerPosition: ListenerProvider;
  getViewport: ViewportProvider;
}): void {
  getListenerPosition = options.getListenerPosition;
  getViewportSize = options.getViewport;
}

export function resetGameAudio(): void {
  getListenerPosition = () => undefined;
  getViewportSize = () => undefined;
  for (const hook of resetHooks) {
    hook();
  }
}

/**
 * Screen-space test matching canvasManager.worldToScreen (local ship at center).
 */
export function isInViewport(
  worldPos: Position,
  listener: Position,
  viewport: ViewportSize
): boolean {
  const screenX = viewport.width / 2 - listener.x + worldPos.x;
  const screenY = viewport.height / 2 - listener.y + worldPos.y;
  return screenX >= 0 && screenX <= viewport.width && screenY >= 0 && screenY <= viewport.height;
}

export function volumeScaleForDistance(distance: number, maxDistance: number): number {
  if (!(maxDistance > 0) || !(distance > 0)) {
    return 1;
  }
  if (distance >= maxDistance) {
    return 0;
  }
  // Smoothstep: stay warmer nearby, blush away toward the edge (not a hard linear drop).
  const t = 1 - distance / maxDistance;
  return t * t * (3 - 2 * t);
}

function maxAudibleDistance(viewport?: ViewportSize): number {
  if (!viewport) {
    return AUDIO.FALLBACK_MAX_DISTANCE;
  }
  return Math.hypot(viewport.width / 2, viewport.height / 2);
}

/**
 * Decide whether to play and at what volume.
 * No position (or no listener) => local / full volume.
 * requireViewport: skip playback when the source is off-screen.
 */
export function planPositionalPlayback(
  sourcePosition: Position | undefined,
  listener: Position | undefined,
  viewport: ViewportSize | undefined,
  options?: { requireViewport?: boolean }
): PlaybackPlan {
  if (sourcePosition === undefined || listener === undefined) {
    return { shouldPlay: true, volumeScale: 1 };
  }

  const requireViewport = options?.requireViewport === true;
  const inViewport = viewport ? isInViewport(sourcePosition, listener, viewport) : true;

  if (requireViewport && viewport && !inViewport) {
    return { shouldPlay: false, volumeScale: 0 };
  }

  let volumeScale = volumeScaleForDistance(
    getDistance(sourcePosition, listener),
    maxAudibleDistance(viewport)
  );

  if (requireViewport && inViewport) {
    volumeScale = Math.max(volumeScale, AUDIO.MIN_IN_VIEWPORT_VOLUME);
  }

  return {
    shouldPlay: volumeScale > 0,
    volumeScale,
  };
}

export function planBoundPlayback(
  sourcePosition: Position | undefined,
  options?: { requireViewport?: boolean }
): PlaybackPlan {
  return planPositionalPlayback(sourcePosition, getListenerPosition(), getViewportSize(), options);
}

export function playWorldSound(
  sound: Sound,
  position?: Position,
  options?: { requireViewport?: boolean }
): void {
  if (!soundIsOn()) {
    return;
  }
  const plan = planBoundPlayback(position, options);
  if (!plan.shouldPlay) {
    return;
  }
  playSound(sound, plan.volumeScale);
}
