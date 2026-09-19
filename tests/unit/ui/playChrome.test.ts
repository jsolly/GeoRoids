import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { initializeTouchControls, syncTouchChrome } from '../../../src/input/touchControls';
import { setPlayView } from '../../../src/ui/uiUtils';

const productionHtml = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
const productionCss = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');
const productionPackage: { dependencies?: Record<string, string> } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
);
const agentsGuide = readFileSync(resolve(__dirname, '../../../AGENTS.md'), 'utf8');

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
});

test('agents guide forbids CDN runtime CSS and JS', () => {
  expect(agentsGuide).toMatch(/No CDN for app assets/u);
  expect(agentsGuide).toMatch(/never load runtime CSS or JS from CDNs/u);
});

test('title shell exposes a terrain canvas and keeps stock credit empty', () => {
  expect(document.querySelector('#title-terrain')?.tagName).toBe('CANVAS');
  expect(document.querySelector('#attribution')?.textContent?.trim()).toBe('');
});

test('Enter Game is an outline phosphor control in the title menu', () => {
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
  expect(document.querySelector('.sound-toggle-label')?.getAttribute('for')).toBe('soundPref');
  expect(document.querySelector('.form-control')).toBeNull();
  expect(document.querySelector('.form-label')).toBeNull();
  expect(document.querySelector('.form-check-input')).toBeNull();
  expect(document.querySelector('.nav-item')).toBeNull();
});

test('title menu keeps Advanced Debug chrome first-party and collapsed', () => {
  const advanced = document.querySelector<HTMLDetailsElement>('#advanced-settings');
  expect(advanced?.tagName).toBe('DETAILS');
  expect(advanced?.open).toBe(false);
  expect(advanced?.querySelector('summary')?.textContent).toBe('Advanced');
  expect(document.querySelector('#debugPref')?.classList.contains('sound-toggle')).toBe(true);
  expect(document.querySelector('label[for="debugPref"]')?.textContent).toBe('Debug');
  expect(document.querySelector('#debug-player-id')?.getAttribute('readonly')).not.toBeNull();
  expect(document.querySelector('#copy-debug-player-id')?.tagName).toBe('BUTTON');
  expect(productionHtml).toMatch(/<details id="advanced-settings"[^>]*>/u);
  expect(productionHtml).not.toMatch(/<details id="advanced-settings"[^>]*\sopen[\s>]/u);
  expect(productionHtml).toContain('Paste this to an agent. Railway filter: @playerId:');
  expect(productionHtml).toContain('id="debug-session-id"');
  expect(productionHtml).toContain('id="debug-play-chip"');
  expect(productionHtml).toContain('id="copy-debug-play-chip"');
  expect(productionHtml).toContain('id="debug-hud"');
  expect(productionHtml).toContain('id="debug-hud-fps"');
  expect(productionCss).toContain('.advanced-settings');
  expect(productionCss).toContain('.debug-hud');
  expect(productionCss).not.toMatch(/#ff0|#ffff00|yellow/iu);
});

test('title menu presents the keyboard and ability control hint', () => {
  const hint = document.querySelector('#controls-hint');
  expect(hint?.closest('#start-screen')).toBeTruthy();
  expect(hint?.textContent).toContain('Always thrust');
  expect(hint?.textContent).toContain('Space fires');
  expect(hint?.textContent).toContain('Shift boost');
  expect(hint?.textContent).toContain('E ability');
  expect(hint?.textContent?.toLowerCase()).not.toContain('shield');
});

test('title menu exposes the ship kit picker before entering play', () => {
  const grid = document.querySelector('#ship-kit-grid');
  expect(grid?.closest('fieldset')?.querySelector('legend')?.textContent).toBe('Ship kit');
  expect(document.querySelector('.ship-kit-placeholder-note')?.textContent).toContain(
    'AD v2 silhouettes'
  );
});

test('play view keeps the controls hint in title chrome and toggles the game area', () => {
  const hint = document.querySelector('#controls-hint');
  const gameArea = document.querySelector<HTMLElement>('#gameArea');
  expect(hint?.closest('#gameArea')).toBeNull();

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
  const boost = document.querySelector('#touch-boost');
  expect(boost?.tagName).toBe('BUTTON');
  expect(boost?.textContent).toBe('BOOST');
  expect(document.querySelector('#touch-shield')).toBeNull();
});
