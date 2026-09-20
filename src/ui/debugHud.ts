import { LOCAL_STORAGE_KEYS } from '../constants/user-preferences';
import { GameController } from '../core/gameController';
import { readDebugHudMetrics, shortReleaseId } from '../diagnostics/debugHudMetrics';
import { getClientReleaseId } from '../utils/buildInfo';
import { getStoredItem, setStoredItem } from '../utils/safeStorage';

const PAINT_INTERVAL_MS = 250;
const MISSING = '—';

let lastPaintAt = 0;
let hudHidden = getStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden) === 'true';

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
  const available = debugOn && inPlay;
  setHidden(document.querySelector('#debug-hud'), !available || hudHidden);
  const toggle = document.querySelector<HTMLButtonElement>('#debug-hud-toggle');
  if (toggle) {
    toggle.hidden = !available;
    setText('debug-hud-toggle', hudHidden ? 'Show HUD' : 'Hide HUD');
    toggle.setAttribute('aria-expanded', String(!hudHidden));
  }
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
  hudHidden = getStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden) === 'true';
}

export function mountDebugHud(): void {
  if (typeof document === 'undefined') {
    return;
  }
  hudHidden = getStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden) === 'true';
  const toggle = document.querySelector<HTMLButtonElement>('#debug-hud-toggle');
  if (toggle) {
    toggle.onclick = () => {
      hudHidden = !hudHidden;
      setStoredItem(LOCAL_STORAGE_KEYS.debugHudHidden, String(hudHidden));
      lastPaintAt = 0;
      paintDebugHud();
    };
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
