import { GameController } from '../core/gameController';
import { readDebugHudMetrics, shortReleaseId } from '../diagnostics/debugHudMetrics';
import { getClientReleaseId } from '../utils/buildInfo';

const PAINT_INTERVAL_MS = 250;
const MISSING = '—';

let lastPaintAt = 0;

function setText(id: string, value: string): void {
  const node = document.querySelector(`#${id}`);
  if (node && node.textContent !== value) {
    node.textContent = value;
  }
}

export function formatDebugFps(fps: number | undefined): string {
  return fps === undefined ? MISSING : String(fps);
}

export function formatDebugRtt(rttMs: number | undefined): string {
  return rttMs === undefined ? MISSING : `${rttMs} ms`;
}

export function formatDebugSnapshot(
  sequence: number | undefined,
  ageMs: number | undefined
): string {
  if (sequence === undefined) {
    return MISSING;
  }
  return ageMs === undefined ? String(sequence) : `${sequence} · ${ageMs} ms`;
}

export function formatDebugMotion(
  motion: { mode: string; epoch: number; ack: number } | undefined
): string {
  if (!motion) {
    return MISSING;
  }
  return `${motion.mode} · e${motion.epoch} · a${motion.ack}`;
}

export function formatDebugWorld(players: number, asteroids: number, loot: number): string {
  return `${players}p · ${asteroids}a · ${loot}l`;
}

export function formatDebugReleases(clientId: string, serverId: string | undefined): string {
  return `${shortReleaseId(clientId)} / ${shortReleaseId(serverId)}`;
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element) {
    element.hidden = hidden;
  }
}

export function syncDebugHudVisibility(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const debugOn = document.body.classList.contains('debug-on');
  const inPlay = document.body.classList.contains('in-play');
  setHidden(document.querySelector('#debug-hud'), !(debugOn && inPlay));
}

export function paintDebugHud(now = performance.now()): void {
  if (typeof document === 'undefined') {
    return;
  }
  syncDebugHudVisibility();
  const panel = document.querySelector<HTMLElement>('#debug-hud');
  if (!panel || panel.hidden) {
    return;
  }
  if (now - lastPaintAt < PAINT_INTERVAL_MS) {
    return;
  }
  lastPaintAt = now;

  const metrics = readDebugHudMetrics(now);
  const game = GameController.getInstance();
  const motion = game.getCurrPlayer()?.ship.playerMotion;
  const players = game.getNetworkManager().getAllPlayers().length;
  const asteroids = game.getCurrRoidCount();
  const loot = game.getLoot().length;
  const serverReleaseId = game.getNetworkManager().getServerReleaseId();

  setText('debug-hud-fps', formatDebugFps(metrics.fps));
  setText('debug-hud-rtt', formatDebugRtt(metrics.rttMs));
  setText('debug-hud-snap', formatDebugSnapshot(metrics.snapshotSequence, metrics.snapshotAgeMs));
  setText('debug-hud-move', formatDebugMotion(motion));
  setText('debug-hud-world', formatDebugWorld(players, asteroids, loot));
  setText('debug-hud-rel', formatDebugReleases(getClientReleaseId(), serverReleaseId));
}

export function resetDebugHudPaintForTests(): void {
  lastPaintAt = 0;
}

export function mountDebugHud(): void {
  if (typeof document === 'undefined') {
    return;
  }
  syncDebugHudVisibility();
  window.addEventListener('playViewOn', () => {
    lastPaintAt = 0;
    paintDebugHud();
  });
  window.addEventListener('playViewOff', () => {
    syncDebugHudVisibility();
  });
}
