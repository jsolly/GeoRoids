import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const productionHtml = readFileSync(
  resolve(__dirname, '../../../src/components/GameDocument.astro'),
  'utf8'
);
const productionCss = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');
const productionPackage: { dependencies?: Record<string, string> } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')
);
const agentsGuide = readFileSync(resolve(__dirname, '../../../AGENTS.md'), 'utf8');

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
