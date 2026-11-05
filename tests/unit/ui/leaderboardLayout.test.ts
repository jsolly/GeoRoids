import { afterEach, expect, test, vi } from 'vitest';

import { createPlayer } from '../../../src/entities/player/createPlayer';
import type { Player } from '../../../src/entities/player/Player';
import { computeHudLayout } from '../../../src/rendering/hud/hudLayout';
import { drawLeaderboard, fitLeaderboardName } from '../../../src/rendering/hud/leaderboard';
import { formatPoints } from '../../../src/utils/formatPoints';

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

function player(id: string, name: string, type: Player['type'], score: number) {
  const participant = createPlayer({
    id,
    name,
    type,
    position: { x: 0, y: 0 },
  });
  participant.score = score;
  return participant;
}

test('crew scores sort stably while current-player emphasis and compact row limits stay readable', () => {
  const { calls, strokes, ctx } = recordingContext();
  const current = player('current', 'Pilot', 'remote', 80);
  const players = [
    player('first-tie', 'Echo', 'remote', 90),
    current,
    player('relay-latest-tie', 'Relay', 'remote', 90),
    player('local', 'Local', 'local', 70),
    player('off-board', 'Below', 'remote', 10),
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
  ]);
  const names = calls.filter((_, index) => index % 3 === 1);
  expect(names).toEqual(
    [
      ['Echo', 18, 'rgba(125, 211, 252, 0.78)'],
      ['Relay', 34, 'rgba(125, 211, 252, 0.78)'],
      ['Pilot', 50, 'rgba(125, 211, 252, 0.92)'],
    ].map(([text, y, color]) => ({
      text,
      x: 684,
      y,
      textAlign: 'left',
      fillStyle: normalizedColor(ctx, String(color)),
      font: '11px Arial',
    }))
  );
  expect(
    calls.filter((_, index) => index % 3 === 2).map(({ x, textAlign }) => ({ x, textAlign }))
  ).toEqual(Array.from({ length: 3 }, () => ({ x: 828, textAlign: 'right' })));
  expect(strokes).toHaveLength(0);
  expect(ctx.textAlign).toBe('center');
  expect(ctx.font).toBe('18px serif');
  expect(ctx.fillStyle).toBe('#123456');
});

test('long mobile leaderboard names fit before a wide right-aligned score', () => {
  const { calls, ctx } = recordingContext();
  const longName = 'QA7skirmisherportrait';
  const wideScore = 987654321;
  const local = player('local', longName, 'local', wideScore);
  const layout = computeHudLayout({ width: 390, height: 844 }, { touchControls: true });
  drawLeaderboard(ctx, layout, [local], local.id);

  const rank = calls.find((call) => call.text === '1.');
  const name = calls.find((call) => call.text.includes('…'));
  // The board prints the same bank the HUD does, through the one formatter, so
  // a row cannot read 24000 beside a bank line reading 24,000 in the same frame.
  const score = calls.find((call) => call.text === formatPoints(wideScore));
  if (!rank || !name || !score) {
    throw new Error('Leaderboard did not draw the rank, truncated name, and grouped score');
  }
  expect(score.text).toBe('987,654,321');
  expect(calls.some((call) => call.text === String(wideScore))).toBe(false);
  expect(name.textAlign).toBe('left');
  expect(score.textAlign).toBe('right');
  ctx.font = name.font;
  const nameWidth = ctx.measureText(name.text).width;
  const scoreWidth = ctx.measureText(score.text).width;
  // Grouping widens the right column, and nameMaxWidth is derived from it, so
  // this is what proves the name still fits rather than overlapping the score.
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
