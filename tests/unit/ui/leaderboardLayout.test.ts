import { expect, test } from 'vitest';

import type { Player } from '../../../src/entities/player/Player';
import { drawLeaderboard, fitLeaderboardName } from '../../../src/rendering/hud/leaderboard';

type FillTextCall = { text: string; x: number; y: number };

function recordingContext(charWidth = 6): {
  calls: FillTextCall[];
  ctx: CanvasRenderingContext2D;
} {
  const calls: FillTextCall[] = [];
  const ctx = {
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    stroke: () => undefined,
    fillText: (text: string, x: number, y: number) => calls.push({ text, x, y }),
    measureText: (text: string) => ({ width: text.length * charWidth }) as TextMetrics,
    fillStyle: '',
    font: '11px Arial',
    textAlign: 'left',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

test('long mobile leaderboard names fit before a wide right-aligned score', () => {
  const { calls, ctx } = recordingContext();
  const longName = 'QA7skirmisherportrait';
  const wideScore = 987654321;
  const player = {
    id: 'local',
    name: longName,
    score: wideScore,
    type: 'local',
    factionId: 'ion',
  } as unknown as Player;

  drawLeaderboard(ctx, { width: 390, height: 844 } as HTMLCanvasElement, [player], player.id);

  const rank = calls.find((call) => call.text === '1.');
  const name = calls.find((call) => call.text.includes('…'));
  const score = calls.find((call) => call.text === String(wideScore));
  expect(rank).toBeDefined();
  expect(name).toBeDefined();
  expect(score).toBeDefined();

  const renderedName = name?.text ?? '';
  const scoreCall = score ?? { x: 0, text: '', y: 0 };
  const nameWidth = ctx.measureText(renderedName).width;
  const scoreWidth = ctx.measureText(scoreCall.text).width;
  expect(nameWidth).toBeLessThanOrEqual(scoreCall.x - (name?.x ?? 0) - scoreWidth - 6);
  expect(renderedName.length).toBeLessThan(longName.length);
});

test('leaderboard name fitting preserves names and Unicode boundaries when there is room', () => {
  const { ctx } = recordingContext();
  expect(fitLeaderboardName(ctx, 'Pilot', 40)).toBe('Pilot');
  expect(fitLeaderboardName(ctx, 'Pilot 🚀', 42)).toBe('Pilot…');
  expect(fitLeaderboardName(ctx, 'Pilot', 0)).toBe('');
});
