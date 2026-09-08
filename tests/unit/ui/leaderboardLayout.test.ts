import { afterEach, expect, test, vi } from 'vitest';

import { entityFactory } from '../../../src/entities/EntityFactory';
import type { Player } from '../../../src/entities/player/Player';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawLeaderboard, fitLeaderboardName } from '../../../src/rendering/hud/leaderboard';

type FillTextCall = {
  text: string;
  x: number;
  y: number;
  textAlign: CanvasTextAlign;
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  font: string;
};

afterEach(() => vi.restoreAllMocks());

function recordingContext() {
  const canvas = document.createElement('canvas');
  canvas.width = 844;
  canvas.height = 844;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Leaderboard scenarios require the real JSDOM canvas context');
  }
  const calls: FillTextCall[] = [];
  const strokes: Array<CanvasRenderingContext2D['strokeStyle']> = [];
  const fillText = ctx.fillText.bind(ctx);
  const stroke = ctx.stroke.bind(ctx);
  vi.spyOn(ctx, 'fillText').mockImplementation((...args) => {
    const [text, x, y] = args;
    calls.push({ text, x, y, textAlign: ctx.textAlign, fillStyle: ctx.fillStyle, font: ctx.font });
    fillText(...args);
  });
  vi.spyOn(ctx, 'stroke').mockImplementation(() => {
    strokes.push(ctx.strokeStyle);
    stroke();
  });
  return { calls, strokes, ctx };
}

function normalizedColor(ctx: CanvasRenderingContext2D, color: string) {
  ctx.save();
  ctx.fillStyle = color;
  const normalized = ctx.fillStyle;
  ctx.restore();
  return normalized;
}

function player(
  id: string,
  name: string,
  type: Player['type'],
  score: number,
  factionId: NonNullable<Player['factionId']>
) {
  const participant = entityFactory.createPlayer({
    id,
    name,
    type,
    factionId,
    position: { x: 0, y: 0 },
  });
  participant.score = score;
  return participant;
}

test('rejoined pilots occupy one row while ties, current-player emphasis and compact row limits survive sorting', () => {
  const { calls, strokes, ctx } = recordingContext();
  const current = player('current', 'Pilot', 'remote', 80, 'ion');
  const players = [
    player('stale-current', 'Pilot', 'remote', 999, 'ember'),
    player('first-tie', 'Echo', 'remote', 90, 'ember'),
    current,
    player('relay-old', 'Relay', 'remote', 40, 'ion'),
    player('relay-improved', 'Relay', 'remote', 90, 'ion'),
    player('relay-latest-tie', 'Relay', 'bot', 90, 'ember'),
    player('local-stale', 'Local', 'remote', 900, 'ember'),
    player('local', 'Local', 'local', 70, 'ion'),
    player('local-ghost', 'Local', 'remote', 800, 'ember'),
    player('current-ghost', 'Pilot', 'remote', 1000, 'ember'),
    player('off-board', 'Below', 'bot', 10, 'ember'),
  ];
  const inputOrder = players.map((participant) => participant.id);
  const layout = computeHudLayout({ width: 844, height: 390 }, { touchControls: true });
  ctx.textAlign = 'center';
  ctx.font = '18px serif';
  ctx.fillStyle = '#123456';

  drawLeaderboard(ctx, layout, players, current.id);

  expect(players.map((participant) => participant.id)).toEqual(inputOrder);
  expect(calls.map((call) => call.text)).toEqual([
    '1.',
    'Echo',
    '90',
    '2.',
    'Relay',
    '90',
    '3.',
    'Pilot',
    '80',
    '4.',
    'Local',
    '70',
  ]);
  const names = calls.filter((_, index) => index % 3 === 1);
  expect(names).toEqual(
    [
      ['Echo', 18, 'rgba(125, 211, 252, 0.78)'],
      ['Relay', 34, 'rgba(251, 146, 60, 0.78)'],
      ['Pilot', 50, 'rgba(125, 211, 252, 0.92)'],
      ['Local', 66, 'rgba(94, 234, 212, 0.78)'],
    ].map(([text, y, color]) => ({
      text,
      x: 692,
      y,
      textAlign: 'left',
      fillStyle: normalizedColor(ctx, String(color)),
      font: '11px Arial',
    }))
  );
  expect(
    calls.filter((_, index) => index % 3 === 2).map(({ x, textAlign }) => ({ x, textAlign }))
  ).toEqual(Array.from({ length: 4 }, () => ({ x: 828, textAlign: 'right' })));
  expect(strokes).toEqual(['#d4b896', '#d4b896', '#a8a0c8', '#a8a0c8']);
  expect(ctx.textAlign).toBe('center');
  expect(ctx.font).toBe('18px serif');
  expect(ctx.fillStyle).toBe('#123456');
});

test('long mobile leaderboard names fit before a wide right-aligned score', () => {
  const { calls, ctx } = recordingContext();
  const longName = 'QA7skirmisherportrait';
  const wideScore = 987654321;
  const local = player('local', longName, 'local', wideScore, 'ion');
  const layout = computeHudLayout({ width: 390, height: 844 }, { touchControls: true });
  drawLeaderboard(ctx, layout, [local], local.id);

  const rank = calls.find((call) => call.text === '1.');
  const name = calls.find((call) => call.text.includes('…'));
  const score = calls.find((call) => call.text === String(wideScore));
  if (!rank || !name || !score) {
    throw new Error('Leaderboard did not draw the rank, truncated name, and score');
  }
  expect(name.textAlign).toBe('left');
  expect(score.textAlign).toBe('right');
  ctx.font = name.font;
  const nameWidth = ctx.measureText(name.text).width;
  const scoreWidth = ctx.measureText(score.text).width;
  expect(nameWidth).toBeLessThanOrEqual(score.x - name.x - scoreWidth - 6);
  expect(name.text.length).toBeLessThan(longName.length);
});

test('leaderboard name fitting preserves names and Unicode boundaries when there is room', () => {
  const { ctx } = recordingContext();
  const measurer: Pick<CanvasRenderingContext2D, 'measureText'> = {
    measureText(text) {
      const metrics = ctx.measureText(text);
      // A split surrogate would fit at 18px; the complete pair requires 24px.
      Object.defineProperty(metrics, 'width', { value: text.length * 6 });
      return metrics;
    },
  };
  expect(fitLeaderboardName(measurer, 'Pilot', 40)).toBe('Pilot');
  expect(fitLeaderboardName(measurer, 'A🚀B', 18)).toBe('A…');
  expect(fitLeaderboardName(measurer, 'A🚀BC', 24)).toBe('A🚀…');
  expect(fitLeaderboardName(measurer, 'Pilot', 0)).toBe('');
});
