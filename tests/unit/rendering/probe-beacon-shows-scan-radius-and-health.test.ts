/* @vitest-environment node */
import { createCanvas } from 'canvas';
import { afterEach, expect, test, vi } from 'vitest';
import type { AsteroidProbe } from '../../../shared-types';
import { PALETTE } from '../../../src/constants';
import { drawSurveyProbe } from '../../../src/entities/roid/surveyProbeRenderer';

const probe: AsteroidProbe = {
  id: 'probe',
  ownerId: 'scout',
  health: 20,
  maxHealth: 40,
  attachedAt: 1000,
  expiresAt: 301000,
  angle: 0,
  radialOffset: 50,
};
afterEach(() => vi.restoreAllMocks());

test('a beacon draws a scaled survey pulse and a proportional satellite-style health bar', () => {
  const ctx = createCanvas(400, 400).getContext('2d');
  const arcs = vi.spyOn(ctx, 'arc');
  const lines = vi.spyOn(ctx, 'lineTo');
  drawSurveyProbe(ctx, probe, { x: 200, y: 200 }, 0.5, 2500);
  expect(arcs.mock.calls[0]).toEqual([200, 200, 150, 0, Math.PI * 2]);
  expect(lines.mock.calls.slice(-2)).toEqual([
    [206, 185],
    [200, 185],
  ]);
});

test('a full-health beacon still advertises its health and warns before battery expiry', () => {
  const ctx = createCanvas(100, 100).getContext('2d');
  const colors: unknown[] = [];
  vi.spyOn(ctx, 'stroke').mockImplementation(() => colors.push(ctx.strokeStyle));
  drawSurveyProbe(ctx, { ...probe, health: 40 }, { x: 50, y: 50 }, 1, 290000);
  expect(colors).toContain(PALETTE.LASER_LOCAL.toLowerCase());
  expect(colors).toContain(PALETTE.HEALTH.toLowerCase());
});

test('a destroyed beacon emits no scan or health bar', () => {
  const ctx = createCanvas(100, 100).getContext('2d');
  const strokes = vi.spyOn(ctx, 'stroke');
  drawSurveyProbe(ctx, { ...probe, health: 0 }, { x: 50, y: 50 }, 1, 2500);
  expect(strokes).not.toHaveBeenCalled();
});
