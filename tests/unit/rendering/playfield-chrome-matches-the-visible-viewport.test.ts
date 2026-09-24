import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { setWindowViewport } from '../../support/viewport';

const productionCss = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');

function requiredPx(pattern: RegExp, label: string): number {
  const match = productionCss.match(pattern);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new Error(`expected ${label} in index.css`);
  }
  return value;
}

let restoreViewport = () => {};
let canvas: HTMLCanvasElement | undefined;
const originalVisualViewport = window.visualViewport;

afterEach(() => {
  canvasManager.destroy();
  canvas = undefined;
  restoreViewport();
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: originalVisualViewport,
  });
  vi.restoreAllMocks();
});

test('the playfield overlay box follows visualViewport when it is smaller than the layout viewport', () => {
  restoreViewport = setWindowViewport(390, 844);
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: {
      width: 360,
      height: 700,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  const playfield = document.querySelector('#gameArea');
  const controls = document.querySelector('#touch-controls');
  const stack = document.querySelector('#debug-play-stack');
  canvas = document.querySelector('#gameCanvas') ?? undefined;
  if (
    !(playfield instanceof HTMLElement) ||
    !(canvas instanceof HTMLCanvasElement) ||
    !(controls instanceof HTMLElement) ||
    !(stack instanceof HTMLElement)
  ) {
    throw new Error('expected #gameArea to wrap canvas, debug stack, and touch controls');
  }
  const ability = document.createElement('button');
  ability.id = 'touch-ability';
  ability.className = 'touch-ability';
  ability.type = 'button';
  ability.textContent = 'HOOK';
  controls.append(ability);

  canvasManager.initialize();

  expect(canvas.style.width).toBe('360px');
  expect(canvas.style.height).toBe('700px');
  expect(playfield.style.width).toBe('360px');
  expect(playfield.style.height).toBe('700px');
  expect(playfield.style.width).not.toBe('390px');
  expect(playfield.contains(ability)).toBe(true);
  expect(playfield.contains(stack)).toBe(true);

  const visualWidth = 360;
  const visualHeight = 700;
  const containingWidth = Number.parseInt(playfield.style.width, 10) || window.innerWidth;
  const containingHeight = Number.parseInt(playfield.style.height, 10) || window.innerHeight;
  const abilitySize = requiredPx(
    /\.touch-ability,\s*\.touch-boost \{[^}]*\bwidth: (\d+)px;/su,
    'ability width'
  );
  const abilityRightInset = requiredPx(
    /\.touch-ability \{\s*right: max\((\d+)px, env\(safe-area-inset-right, 0px\)\);/u,
    'ability right inset'
  );
  const abilityBottomSafe = requiredPx(
    /\.touch-ability,\s*\.touch-boost \{[^}]*bottom: calc\(max\((\d+)px, env\(safe-area-inset-bottom, 0px\)\) \+ \d+px\);/su,
    'ability bottom safe inset'
  );
  const abilityBottomExtra = requiredPx(
    /\.touch-ability,\s*\.touch-boost \{[^}]*bottom: calc\(max\(\d+px, env\(safe-area-inset-bottom, 0px\)\) \+ (\d+)px\);/su,
    'ability bottom extra inset'
  );
  const stackLeft = requiredPx(
    /\.debug-play-stack \{[^}]*left: max\((\d+)px, env\(safe-area-inset-left, 0px\)\);/su,
    'debug stack left'
  );
  const stackGutter = requiredPx(
    /\.debug-play-stack \{[^}]*max-width: min\(calc\(100% - (\d+)px\), \d+px\);/su,
    'debug stack gutter'
  );
  const stackCap = requiredPx(
    /\.debug-play-stack \{[^}]*max-width: min\(calc\(100% - \d+px\), (\d+)px\);/su,
    'debug stack max width'
  );
  const discRight = containingWidth - abilityRightInset;
  const discLeft = discRight - abilitySize;
  const discBottom = containingHeight - abilityBottomSafe - abilityBottomExtra;
  const discTop = discBottom - abilitySize;
  const stackRight = stackLeft + Math.min(containingWidth - stackGutter, stackCap);
  expect(discLeft).toBeGreaterThanOrEqual(0);
  expect(discTop).toBeGreaterThanOrEqual(0);
  expect(discRight).toBeLessThanOrEqual(visualWidth);
  expect(discBottom).toBeLessThanOrEqual(visualHeight);
  expect(stackRight).toBeLessThanOrEqual(visualWidth);

  canvasManager.destroy();
  ability.remove();
  expect(playfield.style.width).toBe('');
  expect(playfield.style.height).toBe('');
});
