import { VISUAL } from '../../constants';

type HudClusterLayout = {
  lifeCenters: { x: number; y: number }[];
  score: { x: number; y: number };
};

export function layoutHudCluster(
  lives: number,
  origin: { x: number; y: number } = { x: VISUAL.HUD_INSET, y: VISUAL.HUD_INSET }
): HudClusterLayout {
  const size = VISUAL.HUD_LIFE_SIZE;
  const gap = VISUAL.HUD_LIFE_GAP;
  const radius = size / 2;
  const lifeCenters: { x: number; y: number }[] = [];

  for (let i = 0; i < lives; i++) {
    lifeCenters.push({
      x: origin.x + radius + i * (size + gap),
      y: origin.y + radius,
    });
  }

  const lastRight = lives > 0 ? origin.x + lives * size + (lives - 1) * gap : origin.x;
  const scoreX = lives > 0 ? lastRight + VISUAL.HUD_SCORE_GAP : origin.x;

  return {
    lifeCenters,
    score: { x: scoreX, y: origin.y + radius },
  };
}
