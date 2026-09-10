import { AuthoritativeProjectileField } from '../../../src/entities/laser/AuthoritativeProjectileField';

interface ReflectionProof {
  shots: Record<string, { energy: number; bounces: number }>;
  timer: number;
}

declare global {
  interface Window {
    __reflectionProof?: ReflectionProof;
  }
}

const evidence: ReflectionProof = { shots: {}, timer: 0 };
window.__reflectionProof = evidence;
evidence.timer = window.setInterval(() => {
  const id = window.gameController?.getPlayerManager().getLocalPlayer()?.id;
  for (const row of AuthoritativeProjectileField.getInstance().getProjectiles()) {
    if (row.ownerId !== id) {
      continue;
    }
    const previous = evidence.shots[row.id];
    evidence.shots[row.id] = {
      energy: Math.max(previous?.energy ?? 0, row.energy),
      bounces: Math.max(previous?.bounces ?? 0, row.bounces),
    };
  }
}, 10);
