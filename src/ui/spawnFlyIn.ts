import { WORLD } from '../../shared/world';
import { PALETTE } from '../constants';
import { PlayerManager } from '../entities/player/PlayerManager';
import { hexToRgba } from '../utils/colorUtils';
import { drawSpawnChart } from './universeMap';

/** Hold on the whole-world chart, dive to the ship, then dissolve into flight. */
const HOLD_MS = 700;
const DIVE_MS = 1900;
const FADE_MS = 450;
/** Chart scale where the dive hands off to the live playfield (flight is 1). */
const HANDOFF_SCALE = 0.35;

const RETICLE_TICKS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

let frameRequest: number | null = null;
let generation = 0;
let overlay: HTMLCanvasElement | null = null;
let visibilityChanged: ((visible: boolean) => void) | undefined;

/** The shell owns the canvas element; this painter owns its pixels and RAF. */
export function mountSpawnFlyIn(
  canvas: HTMLCanvasElement,
  onVisibility: (visible: boolean) => void
): () => void {
  stopSpawnFlyIn();
  overlay = canvas;
  visibilityChanged = onVisibility;
  onVisibility(false);
  return () => {
    if (overlay !== canvas) {
      return;
    }
    stopSpawnFlyIn();
    overlay = null;
    visibilityChanged = undefined;
  };
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function stopSpawnFlyIn(): void {
  generation++;
  if (frameRequest !== null) {
    window.cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }
  visibilityChanged?.(false);
  window.removeEventListener('keydown', stopSpawnFlyIn, true);
  window.removeEventListener('pointerdown', stopSpawnFlyIn, true);
}

/** Isonzo-style deploy camera: whole world → local ship. Any key or tap skips it. */
export function playSpawnFlyIn(): void {
  stopSpawnFlyIn();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const canvas = overlay;
  const context = canvas?.getContext('2d');
  if (!canvas || !context) {
    return;
  }
  visibilityChanged?.(true);
  window.addEventListener('keydown', stopSpawnFlyIn, true);
  window.addEventListener('pointerdown', stopSpawnFlyIn, true);
  const started = performance.now();
  const ticket = generation;

  const render = (now: number): void => {
    if (generation !== ticket || overlay !== canvas) {
      return;
    }
    frameRequest = null;
    const ship = PlayerManager.getInstance().getLocalPlayer()?.ship;
    const elapsed = now - started;
    if (!ship || elapsed >= HOLD_MS + DIVE_MS + FADE_MS) {
      stopSpawnFlyIn();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    const worldScale = (Math.min(width, height) * 0.92) / (WORLD.radius * 2);
    const dive = easeInOutCubic(Math.min(1, Math.max(0, (elapsed - HOLD_MS) / DIVE_MS)));
    // Zoom geometrically so every stretch of the dive feels equally fast.
    const scale = worldScale * (HANDOFF_SCALE / worldScale) ** dive;
    const center = { x: ship.position.x * dive, y: ship.position.y * dive };
    const fade = Math.min(1, Math.max(0, (elapsed - HOLD_MS - DIVE_MS + FADE_MS) / FADE_MS));

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalAlpha = 1 - fade;
    context.fillStyle = PALETTE.BG;
    context.fillRect(0, 0, width, height);
    drawSpawnChart(context, width, height, center, scale);

    // Target reticle on the ship, tightening as the camera arrives.
    const sx = width / 2 + (ship.position.x - center.x) * scale;
    const sy = height / 2 + (ship.position.y - center.y) * scale;
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    const radius = 34 - 20 * dive + 4 * pulse;
    context.strokeStyle = hexToRgba(PALETTE.HUD, 0.9);
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(sx, sy, radius, 0, Math.PI * 2);
    for (const [dx, dy] of RETICLE_TICKS) {
      context.moveTo(sx + dx * (radius + 4), sy + dy * (radius + 4));
      context.lineTo(sx + dx * (radius + 14), sy + dy * (radius + 14));
    }
    context.stroke();

    context.globalAlpha = 1;
    frameRequest = window.requestAnimationFrame(render);
  };
  frameRequest = window.requestAnimationFrame(render);
}
