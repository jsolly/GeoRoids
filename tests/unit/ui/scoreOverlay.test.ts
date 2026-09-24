import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { expect, test } from 'vitest';

const gameInfoSrc = readFileSync(resolve(process.cwd(), 'src/rendering/hud/gameInfo.ts'), 'utf8');
const FACTION_OR_TEAM_PATTERN = /FACTION_LABELS|getSideColor|faction/iu;
const TEAM_SCORE_PATTERN = /teamScore|team win|TEAM SCORE/iu;

test('delivery toast does not replace the score', () => {
  const scoreDraw = gameInfoSrc.indexOf('fillText(`Bank ');
  const deliveryDraw = gameInfoSrc.indexOf('hasPickupMessage()');
  expect(scoreDraw).toBeGreaterThan(0);
  expect(deliveryDraw).toBeGreaterThan(scoreDraw);
});

test('HUD shows personal score without a faction or team label', () => {
  expect(gameInfoSrc).not.toMatch(FACTION_OR_TEAM_PATTERN);
  expect(gameInfoSrc).not.toMatch(TEAM_SCORE_PATTERN);
});
