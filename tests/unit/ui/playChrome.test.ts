import { afterEach, expect, test } from 'vitest';

import { initializeTouchControls, syncTouchChrome } from '../../../src/input/touchControls';
import { setPlayView } from '../../../src/ui/uiUtils';

afterEach(() => {
  setPlayView(false);
  document.body.classList.remove('touch-play');
  const root = document.getElementById('touch-controls');
  if (root) {
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }
});

test('title shell exposes a terrain canvas and keeps stock credit empty', () => {
  expect(document.getElementById('title-terrain')?.tagName).toBe('CANVAS');
  expect(document.getElementById('attribution')?.textContent?.trim()).toBe('');
});

test('Enter Game is an outline phosphor control in the title menu', () => {
  const start = document.getElementById('start-game');
  expect(start?.tagName).toBe('BUTTON');
  expect(start?.classList.contains('btn-phosphor')).toBe(true);
  expect(start?.classList.contains('btn-success')).toBe(false);
});

test('title menu presents the keyboard and E/F control hint', () => {
  const hint = document.getElementById('controls-hint');
  expect(hint?.closest('#start-screen')).toBeTruthy();
  expect(hint?.textContent).toContain('WASD + Space / arrows');
  expect(hint?.textContent).toContain('E ability');
  expect(hint?.textContent).toContain('F shield');
});

test('title menu exposes the ship kit picker before entering play', () => {
  const grid = document.getElementById('ship-kit-grid');
  expect(grid?.getAttribute('role')).toBe('group');
  expect(grid?.getAttribute('aria-label')).toBe('Ship kit');
  expect(document.querySelector('.ship-kit-placeholder-note')?.textContent).toContain(
    'AD v2 silhouettes'
  );
});

test('play view keeps the controls hint in title chrome and toggles the game area', () => {
  const hint = document.getElementById('controls-hint');
  const gameArea = document.getElementById('gameArea');
  expect(hint?.closest('#gameArea')).toBeNull();

  setPlayView(true);
  expect(document.body.classList.contains('in-play')).toBe(true);
  expect(document.getElementById('start-screen')?.style.display).toBe('none');
  expect(gameArea?.style.display).toBe('block');

  setPlayView(false);
  expect(document.body.classList.contains('in-play')).toBe(false);
  expect(document.getElementById('start-screen')?.style.display).toBe('block');
  expect(gameArea?.style.display).toBe('none');
});

test('play shell creates the full touch overlay with semantic action buttons', () => {
  initializeTouchControls();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  document.body.classList.add('in-play');
  syncTouchChrome(true);

  expect(document.body.classList.contains('touch-play')).toBe(true);
  const root = document.getElementById('touch-controls');
  expect(root?.hidden).toBe(false);
  for (const id of ['touch-stick', 'touch-fire', 'touch-ability', 'touch-shield']) {
    expect(document.getElementById(id)).toBeTruthy();
  }
  for (const id of ['touch-fire', 'touch-ability', 'touch-shield']) {
    const action = document.getElementById(id);
    expect(action?.tagName).toBe('BUTTON');
    expect(action?.getAttribute('type')).toBe('button');
    expect(action?.getAttribute('aria-label')).toBeTruthy();
  }
});
