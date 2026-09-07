import { expect, test } from 'vitest';

import { DEBUG, PALETTE, ROID, SHIP, TITLE, VISUAL } from '../../../src/constants';
import { getRoidStrokeWidth } from '../../../src/entities/roid/roidRenderer';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { Ship } from '../../../src/entities/ship/Ship';
import {
  applyLockedPaletteCss,
  generateRandomPlayerColor,
  getFactionColor,
  getLaserColor,
  getShipDisplayColor,
  hexToRgba,
} from '../../../src/utils/colorUtils';
import { FACTION_COLORS } from '../../../shared/factions';
import { isDebugMode } from '../../../src/utils/debugUtils';

test('locked palette hexes match the art-direction swatch', () => {
  expect(PALETTE.BG).toBe('#000011');
  expect(PALETTE.STARS).toBe('#8BA3C7');
  expect(PALETTE.LOCAL).toBe('#5EEAD4');
  expect(PALETTE.REMOTE).toBe('#7DD3FC');
  expect(PALETTE.BOT).toBe('#FB923C');
  expect(PALETTE.ROID).toBe('#94A3B8');
  expect(PALETTE.LASER_LOCAL).toBe('#FDE68A');
  expect(PALETTE.LASER_ENEMY).toBe('#FCA5A5');
  expect(PALETTE.HUD).toBe('#E2E8F0');
  expect(PALETTE.HUD_MUTED).toBe('#64748B');
  expect(PALETTE.DANGER).toBe('#F43F5E');
  expect(PALETTE.HEALTH).toBe('#4ADE80');
  expect(PALETTE.LOOT).toBe('#E8D5A3');
  expect(TITLE.ACCENT).toBe('#A78BFA');
  expect(PALETTE).not.toHaveProperty('ACCENT_UI');
  expect(PALETTE.SHIELD).toBe('#7DD3C8');
  expect(PALETTE.SHIELD.toLowerCase()).not.toBe('#ffffff');
  expect(PALETTE.SATELLITE_PICKUP).toBe('#FBBF24');
  expect(PALETTE.SATELLITE_PICKUP.toLowerCase()).not.toBe('#ffffff');
  expect(PALETTE.SATELLITE_PICKUP.toLowerCase()).not.toBe('#67e8f9');
});

test('faction colors map local mint, remote sky, bot amber', () => {
  expect(getFactionColor('local')).toBe(PALETTE.LOCAL);
  expect(getFactionColor('remote')).toBe(PALETTE.REMOTE);
  expect(getFactionColor('bot')).toBe(PALETTE.BOT);
  expect(getFactionColor('local')).toBe('#5EEAD4');
  expect(getFactionColor('bot')).toBe('#FB923C');
});

test('hull display color stays ownership even when a side is assigned', () => {
  expect(getShipDisplayColor({ type: 'local', faction: 'ember' })).toBe(PALETTE.LOCAL);
  expect(getShipDisplayColor({ type: 'bot', faction: 'ion' })).toBe(PALETTE.BOT);
  expect(getShipDisplayColor({ type: 'remote', faction: 'ion' })).toBe(PALETTE.REMOTE);
  expect(getShipDisplayColor({ type: 'local', faction: 'ember' })).not.toBe(FACTION_COLORS.ember);
  expect(getShipDisplayColor({ type: 'bot', faction: 'ion' })).not.toBe(FACTION_COLORS.ion);
});

test('laser colors never use white', () => {
  expect(getLaserColor(true)).toBe(PALETTE.LASER_LOCAL);
  expect(getLaserColor(false)).toBe(PALETTE.LASER_ENEMY);
  expect(getLaserColor(true).toLowerCase()).not.toBe('#ffffff');
  expect(getLaserColor(false).toLowerCase()).not.toBe('#ffffff');
});

test('new players and ships default to faction colors instead of white', () => {
  const local = new Player({
    id: 'p-local',
    name: 'Local',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const remote = new Player({
    id: 'p-remote',
    name: 'Remote',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  const bot = new Player({
    id: 'p-bot',
    name: 'Bot',
    type: 'bot',
    input: new MockPlayerInput(),
  });

  expect(local.color).toBe(PALETTE.LOCAL);
  expect(local.ship.color).toBe(PALETTE.LOCAL);
  expect(remote.color).toBe(PALETTE.REMOTE);
  expect(bot.color).toBe(PALETTE.BOT);
  expect(new Ship().color).toBe(PALETTE.LOCAL);
  expect(generateRandomPlayerColor().toLowerCase()).not.toBe('#ffffff');
});

test('hexToRgba preserves locked hex channels', () => {
  expect(hexToRgba(PALETTE.LOCAL, 0.5)).toBe('rgba(94, 234, 212, 0.5)');
});

test('hexToRgba returns the same string instance for the same quantized alpha', () => {
  const a = hexToRgba(PALETTE.STARS, 0.42);
  const b = hexToRgba(PALETTE.STARS, 0.42);
  expect(a).toBe(b);
});

test('roid stroke weights follow three size tiers', () => {
  expect(getRoidStrokeWidth(ROID.SIZE)).toBe(VISUAL.ROID_STROKE_LARGE);
  expect(getRoidStrokeWidth(ROID.SIZE * 0.5)).toBe(VISUAL.ROID_STROKE_MEDIUM);
  expect(getRoidStrokeWidth(ROID.SIZE * 0.2)).toBe(VISUAL.ROID_STROKE_SMALL);
});

test('shots are short cream segments, never pins or beams', () => {
  expect(VISUAL.LASER_STROKE_WIDTH).toBeLessThanOrEqual(2.25);
  expect(VISUAL.LASER_LENGTH).toBeGreaterThanOrEqual(12);
  expect(VISUAL.LASER_LENGTH).toBeLessThanOrEqual(18);
  expect(VISUAL.LASER_TRAIL_LENGTH).toBeLessThan(VISUAL.LASER_LENGTH);
  expect(VISUAL.LASER_EXPLODE_RADIUS).toBeLessThanOrEqual(VISUAL.LASER_LENGTH);
});

test('ships stay hairline; roids read as silhouettes', () => {
  expect(VISUAL.SHIP_STROKE_WIDTH).toBeLessThanOrEqual(1.5);
  expect(VISUAL.ROID_STROKE_LARGE).toBeLessThanOrEqual(2.25);
  expect(VISUAL.ROID_STROKE_MEDIUM).toBeLessThanOrEqual(VISUAL.ROID_STROKE_LARGE);
  expect(VISUAL.ROID_STROKE_SMALL).toBeLessThanOrEqual(VISUAL.ROID_STROKE_MEDIUM);
  expect(VISUAL.THRUSTER_STROKE_WIDTH).toBeLessThanOrEqual(1.5);
  expect(VISUAL.EXPLOSION_STROKE_WIDTH).toBeLessThanOrEqual(1.5);
});

test('thruster trail flickers shorter than the outer V', () => {
  expect(VISUAL.THRUSTER_LENGTH_RATIO).toBeLessThanOrEqual(0.75);
  expect(VISUAL.THRUSTER_FLICKER_RATIO).toBeLessThan(VISUAL.THRUSTER_LENGTH_RATIO);
  expect(VISUAL.THRUSTER_CORE_RATIO).toBeGreaterThan(0);
  expect(VISUAL.THRUSTER_CORE_RATIO).toBeLessThan(1);
});

test('juice bloom stays modest and ships stay crisp', () => {
  expect(VISUAL.SHIP_GLOW).toBeLessThanOrEqual(VISUAL.SHIP_STROKE_WIDTH);
  expect(VISUAL.LASER_GLOW).toBeLessThanOrEqual(VISUAL.LASER_STROKE_WIDTH * 2);
  expect(VISUAL.ROID_GLOW).toBeLessThanOrEqual(VISUAL.ROID_STROKE_LARGE * 1.25);
  expect(VISUAL.THRUSTER_GLOW).toBeLessThanOrEqual(VISUAL.THRUSTER_STROKE_WIDTH * 2);
  expect(VISUAL.BOUNDARY_GLOW).toBeLessThanOrEqual(VISUAL.BOUNDARY_STROKE_WIDTH);
});

test('default play path keeps debug chrome gated off', () => {
  expect(DEBUG.ENABLED).toBe(false);
  expect(isDebugMode()).toBe(false);
});

test('HUD score stays readable in the compact cluster and name labels stay faded', () => {
  expect(VISUAL.SCORE_FONT).toBe('14px Arial');
  expect(VISUAL.HUD_LIFE_SIZE).toBeLessThan(SHIP.SIZE / 2);
  expect(VISUAL.NAME_LABEL_ALPHA).toBeLessThanOrEqual(0.45);
  expect(VISUAL.NAME_LABEL_ALPHA).toBeGreaterThan(0);
});

test('applyLockedPaletteCss writes title/menu custom properties', () => {
  const props = new Map<string, string>();
  applyLockedPaletteCss({
    setProperty(name: string, value: string) {
      props.set(name, value);
    },
  } as CSSStyleDeclaration);
  expect(props.get('--palette-bg')).toBe(PALETTE.BG);
  expect(props.get('--palette-stars')).toBe(PALETTE.STARS);
  expect(props.get('--palette-accent')).toBe(TITLE.ACCENT);
  expect(props.get('--palette-local')).toBe(PALETTE.LOCAL);
  expect(props.get('--palette-hud')).toBe(PALETTE.HUD);
  expect(props.get('--palette-hud-muted')).toBe(PALETTE.HUD_MUTED);
  expect(props.get('--palette-danger')).toBe(PALETTE.DANGER);
  expect(props.get('--palette-laser')).toBe(PALETTE.LASER_LOCAL);
});
