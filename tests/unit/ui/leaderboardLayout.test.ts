import { expect, test } from 'vitest';

import { entityFactory } from '../../../src/entities/EntityFactory';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawLeaderboard, fitLeaderboardName } from '../../../src/rendering/hud/leaderboard';

type FillTextCall = { text: string; x: number; y: number; textAlign: CanvasTextAlign };

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
    fillText: (text: string, x: number, y: number) =>
      calls.push({ text, x, y, textAlign: ctx.textAlign }),
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
  const player = entityFactory.createPlayer({
    id: 'local',
    name: longName,
    type: 'local',
    factionId: 'ion',
    position: { x: 0, y: 0 },
  });
  player.score = wideScore;

  const layout = computeHudLayout({ width: 390, height: 844 }, { touchControls: true });
  drawLeaderboard(ctx, layout, [player], player.id);

  const rank = calls.find((call) => call.text === '1.');
  const name = calls.find((call) => call.text.includes('…'));
  const score = calls.find((call) => call.text === String(wideScore));
  if (!rank || !name || !score) {
    throw new Error('Leaderboard did not draw the rank, truncated name, and score');
  }
  expect(name.textAlign).toBe('left');
  expect(score.textAlign).toBe('right');

  const nameWidth = ctx.measureText(name.text).width;
  const scoreWidth = ctx.measureText(score.text).width;
  expect(nameWidth).toBeLessThanOrEqual(score.x - name.x - scoreWidth - 6);
  expect(name.text.length).toBeLessThan(longName.length);
});

test('leaderboard name fitting preserves names and Unicode boundaries when there is room', () => {
  const { ctx } = recordingContext();
  expect(fitLeaderboardName(ctx, 'Pilot', 40)).toBe('Pilot');
  expect(fitLeaderboardName(ctx, 'A🚀B', 18)).toBe('A…');
  expect(fitLeaderboardName(ctx, 'A🚀BC', 24)).toBe('A🚀…');
  expect(fitLeaderboardName(ctx, 'Pilot', 0)).toBe('');
});
