import { expect, test } from 'vitest';
import {
  areAllied,
  areHostile,
  canApplyCombatDamage,
  countFactions,
  FACTION_COLORS,
  isEnvironmentAttacker,
  pickBalancedFaction,
  pickBalancedFactionFromShips,
} from '../../../shared/factions';

test('side colors are blue Ion and orange Ember', () => {
  expect(FACTION_COLORS.ion).toBe('#7DD3FC');
  expect(FACTION_COLORS.ember).toBe('#FB923C');
});

test('auto-balance fills the smaller faction and ties go to ion', () => {
  expect(pickBalancedFaction([])).toBe('ion');
  expect(pickBalancedFaction(['ion'])).toBe('ember');
  expect(pickBalancedFaction(['ember'])).toBe('ion');
  expect(pickBalancedFaction(['ion', 'ember'])).toBe('ion');
  expect(pickBalancedFaction(['ion', 'ion', 'ember'])).toBe('ember');
});

test('countFactions ignores unset sides', () => {
  expect(countFactions([undefined, 'ion', 'ember', 'ion'])).toEqual({ ion: 2, ember: 1 });
});

test('side assignment ignores ship kit fields on the same hull', () => {
  expect(
    pickBalancedFactionFromShips([
      { faction: 'ion', kit: 'quake' },
      { faction: 'ember', kit: 'dart' },
    ])
  ).toBe('ion');
  expect(
    pickBalancedFactionFromShips([
      { faction: 'ion', kit: 'hauler' },
      { faction: 'ion', kit: 'warden' },
      { faction: 'ember', kit: 'skirmisher' },
    ])
  ).toBe('ember');
});

test('same-side ships are allied; opposite and unknown are hostile', () => {
  expect(areAllied('ion', 'ion')).toBe(true);
  expect(areAllied('ember', 'ion')).toBe(false);
  expect(areAllied('ion', undefined)).toBe(false);
  expect(areHostile('ion', 'ember')).toBe(true);
  expect(areHostile(undefined, 'ember')).toBe(true);
});

test('environment hits always apply; same-faction ship fire does not', () => {
  expect(isEnvironmentAttacker('asteroid')).toBe(true);
  expect(isEnvironmentAttacker('boundary')).toBe(true);
  expect(canApplyCombatDamage('asteroid', 'ion', 'ion')).toBe(true);
  expect(canApplyCombatDamage('boundary', 'ember', 'ember')).toBe(true);
  expect(canApplyCombatDamage('pilot-1', 'ion', 'ion')).toBe(false);
  expect(canApplyCombatDamage('pilot-1', 'ion', 'ember')).toBe(true);
  expect(canApplyCombatDamage('pilot-1', undefined, 'ember')).toBe(true);
});
