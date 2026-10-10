import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, expect, test } from 'vitest';

import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { initializeTouchControls, syncTouchChrome } from '../../../src/input/touchControls';
import { NetworkManager } from '../../../src/network/networkManager';
import { setPlayView } from '../../../src/ui/uiUtils';

const productionHtml = readFileSync(
  resolve(__dirname, '../../../src/components/LegacyGameDocument.astro'),
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
  expect(productionHtml).toContain('class="enter-game"');
  expect(productionHtml).toContain('class="nickname-input"');
  expect(productionHtml).toContain('class="sound-toggle"');
  expect(productionHtml).toContain('id="hapticsPref"');
  expect(productionHtml).toContain('class="preference-toggles"');
  expect(productionCss).toMatch(/\.preference-toggles \{[^}]*flex-wrap: wrap;/su);
  expect(productionCss).not.toMatch(
    /\.preference-toggles \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/su
  );
  expect(productionHtml).toContain('id="hapticsRow" class="sound-toggle-row" hidden');
});

test('agents guide forbids CDN runtime CSS and JS', () => {
  expect(agentsGuide).toMatch(/No CDN for app assets/u);
  expect(agentsGuide).toMatch(/never load runtime CSS or JS from CDNs/u);
});

test('title shell exposes a terrain canvas and keeps stock credit empty', () => {
  expect(document.querySelector('#title-terrain')?.tagName).toBe('CANVAS');
  expect(document.querySelector('#attribution')?.textContent?.trim()).toBe('');
});

test('the pilot enters through the first-party title menu button', () => {
  const start = document.querySelector('#start-game');
  expect(start?.tagName).toBe('BUTTON');
  expect(start?.classList.contains('enter-game')).toBe(true);
  expect(start?.classList.contains('btn')).toBe(false);
  expect(start?.classList.contains('btn-phosphor')).toBe(false);
  expect(start?.classList.contains('btn-success')).toBe(false);
});

test('title menu uses first-party nickname and sound chrome', () => {
  expect(document.querySelector('.nickname-label')?.getAttribute('for')).toBe('playerNameInput');
  expect(document.querySelector('#playerNameInput')?.classList.contains('nickname-input')).toBe(
    true
  );
  expect(document.querySelector('#soundPref')?.classList.contains('sound-toggle')).toBe(true);
  expect(document.querySelector('label[for="soundPref"]')?.textContent?.trim()).toBe(
    'Sound Effects'
  );
  expect(document.querySelector('#musicPref')?.classList.contains('sound-toggle')).toBe(true);
  expect(document.querySelector('label[for="musicPref"]')?.textContent?.trim()).toBe('Music');
  expect(document.querySelector('#hapticsPref')?.classList.contains('sound-toggle')).toBe(true);
  expect(document.querySelector('label[for="hapticsPref"]')?.textContent?.trim()).toBe('Haptics');
  expect(document.querySelector('.form-control')).toBeNull();
  expect(document.querySelector('.form-label')).toBeNull();
  expect(document.querySelector('.form-check-input')).toBeNull();
  expect(document.querySelector('.nav-item')).toBeNull();
});

test('the player menu keeps instructions and diagnostics out of the join flow', () => {
  expect(document.querySelector('#advanced-settings')).toBeNull();
  expect(document.querySelector('#debugPref')).toBeNull();
  expect(document.querySelector('#debug-log-level')).toBeNull();
  expect(document.querySelector('#controls-hint')).toBeNull();
  expect(document.querySelector('.terrain-eyebrow')).toBeNull();
  expect(document.querySelector('.game-description')).toBeNull();
  expect(document.querySelector<HTMLElement>('#debug-identity')?.hidden).toBe(true);
  expect(document.querySelector<HTMLInputElement>('#debug-player-id')?.readOnly).toBe(true);
  expect(document.querySelector('#debug-session-id')).toBeTruthy();
  expect(document.querySelector('.manual-entry a')?.getAttribute('href')).toBe('/wiki/');
});

test('playfield chrome ships an Inventory button with the V shortcut', () => {
  const toggle = document.querySelector('#ship-schematic-toggle');
  const map = document.querySelector('#universe-map-toggle');
  expect(toggle?.tagName).toBe('BUTTON');
  expect(toggle?.getAttribute('aria-keyshortcuts')).toBe('V');
  expect(toggle?.querySelector('kbd')?.textContent).toBe('V');
  expect(toggle && map ? toggle.compareDocumentPosition(map) : 0).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );
  expect(productionHtml).toContain('id="ship-schematic-toggle"');
  expect(productionHtml).toContain('Inventory <kbd>V</kbd>');
  expect(productionHtml.indexOf('id="ship-schematic-toggle"')).toBeLessThan(
    productionHtml.indexOf('id="universe-map-toggle"')
  );
  expect(productionCss).toContain('.ship-schematic-toggle');
  expect(productionCss).toContain('--schematic-toggle-y');
});

test('title menu exposes the ship kit picker before entering play', () => {
  const grid = document.querySelector('#ship-kit-grid');
  expect(grid?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Choose your ship');
  expect(document.querySelector('.ship-kit-placeholder-note')).toBeNull();
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

  expect(document.body.classList.contains('touch-play')).toBe(true);
  const root = document.querySelector<HTMLElement>('#touch-controls');
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
