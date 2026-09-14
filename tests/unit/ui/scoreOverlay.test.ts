import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const gameInfoSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/gameInfo.ts'), 'utf8');

test('delivery toast does not replace the score', () => {
  const scoreDraw = gameInfoSrc.indexOf('fillText(score.toString()');
  const deliveryDraw = gameInfoSrc.indexOf('hasPickupMessage()');
  expect(scoreDraw).toBeGreaterThan(0);
  expect(deliveryDraw).toBeGreaterThan(scoreDraw);
});

test('HUD shows personal score without a faction or team label', () => {
  expect(gameInfoSrc).not.toMatch(/FACTION_LABELS|getSideColor|faction/i);
  expect(gameInfoSrc).not.toMatch(/teamScore|team win|TEAM SCORE/i);
});
