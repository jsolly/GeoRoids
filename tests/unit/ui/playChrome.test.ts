import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';

import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { initializeTouchControls, syncTouchChrome } from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { setPlayView } from '../../../src/ui/uiUtils';

const productionHtml = readFileSync(
  resolve(__dirname, '../../../src/components/GameDocument.astro'),
  'utf8'
);
const productionCss = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');
const productionPackage: { dependencies?: Record<string, string> } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
);
const agentsGuide = readFileSync(resolve(__dirname, '../../../AGENTS.md'), 'utf8');

beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

afterEach(() => {
  setPlayView(false);
  document.body.classList.remove('touch-play');
  const root = document.querySelector<HTMLElement>('#touch-controls');
  if (root) {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }
});

test('play client ships first-party GeoRoids CSS with no Bootstrap package or CDN', () => {
  expect(productionHtml).not.toMatch(/bootstrap|jsdelivr|cdn\./iu);
  expect(productionCss).not.toMatch(/bootstrap/iu);
  expect(productionCss).toContain('@layer georoids');
  expect(productionCss).not.toContain('@layer bootstrap');
  expect(productionPackage.dependencies?.['bootstrap']).toBeUndefined();
});

test('agents guide forbids CDN runtime CSS and JS', () => {
  expect(agentsGuide).toMatch(/No CDN for app assets/u);
  expect(agentsGuide).toMatch(/never load runtime CSS or JS from CDNs/u);
});

test('title shell exposes a terrain canvas and keeps stock credit empty', () => {
  expect(document.querySelector('#title-terrain')?.tagName).toBe('CANVAS');
  expect(document.querySelector('#attribution')?.textContent?.trim()).toBe('');
});

test('joining swaps the menu for the playfield and returning restores the menu', () => {
  const hint = document.querySelector('#controls-hint');
  const gameArea = document.querySelector<HTMLElement>('#gameArea');
  expect(hint).toBeNull();

  setPlayView(true);
  expect(document.body.classList.contains('in-play')).toBe(true);
  expect(document.querySelector<HTMLElement>('#start-screen')?.style.display).toBe('none');
  expect(gameArea?.style.display).toBe('block');

  setPlayView(false);
  expect(document.body.classList.contains('in-play')).toBe(false);
  expect(document.querySelector<HTMLElement>('#start-screen')?.style.display).toBe('block');
  expect(gameArea?.style.display).toBe('none');
});

test('play shell creates the touch ability overlay with a semantic action button', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);

  const root = document.querySelector<HTMLElement>('#touch-controls');
  expect(root?.classList.contains('is-touch')).toBe(true);
  expect(root?.hidden).toBe(false);
  const action = document.querySelector('#touch-ability');
  expect(action?.tagName).toBe('BUTTON');
  expect(action?.getAttribute('type')).toBe('button');
  expect(action?.getAttribute('aria-label')).toBeTruthy();
  const boost = document.querySelector('#touch-contour-lock');
  expect(boost?.tagName).toBe('BUTTON');
  expect(boost?.textContent?.trim()).toBe('CONTOUR LOCK');
  expect(document.querySelector('#touch-shield')).toBeNull();
});
