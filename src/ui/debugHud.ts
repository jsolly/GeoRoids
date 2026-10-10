import { shortReleaseId } from '../diagnostics/debugHudMetrics';

const MISSING = '—';

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
