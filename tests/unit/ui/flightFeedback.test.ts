import { afterEach, expect, test } from 'vitest';
import type { AsteroidToolsState } from '../../../src/asteroidTools/AsteroidToolsController';
import { FlightFeedback } from '../../../src/asteroidTools/FlightFeedback';

afterEach(() => document.body.replaceChildren());

test('target cycling announces distinct rocks without announcing every moving snapshot', () => {
  const feedback = new FlightFeedback(document.body);
  const rock = { id: 'first', size: 20, position: { x: 100, y: 0 }, material: 'metal' as const };
  const second = { ...rock, id: 'second' };
  const state: AsteroidToolsState = {
    pilot: { alive: true, position: { x: 0, y: 0 } },
    targets: [rock, second],
    selectedTarget: rock,
    selectedTargetId: rock.id,
    status: 'Target selected',
  };
  feedback.update(state);
  const announcement = document.getElementById('flight-selection-announcement');
  expect(announcement?.getAttribute('role')).toBe('status');
  expect(announcement?.textContent).toBe('Target 1 of 2, metal, 100 meters');
  feedback.update({ ...state, selectedTarget: { ...rock, position: { x: 99, y: 0 } } });
  expect(announcement?.textContent).toBe('Target 1 of 2, metal, 100 meters');
  feedback.update({ ...state, selectedTarget: second, selectedTargetId: second.id });
  expect(announcement?.textContent).toBe('Target 2 of 2, metal, 100 meters');
  feedback.update({ pilot: { alive: true }, targets: state.targets, status: 'Ready' });
  expect(announcement?.textContent).toBe('Target cleared');
  expect(
    document.querySelectorAll(
      '#flight-feedback button, #flight-feedback select, #flight-feedback input, #flight-feedback [tabindex]'
    ).length
  ).toBe(0);
  feedback.dispose();
});

test('core pickup reports charges and time during flight and disappears on expiry or death', () => {
  const feedback = new FlightFeedback(document.body);
  const state: AsteroidToolsState = {
    pilot: { alive: true, laserUpgrade: { charges: 6, expiresAt: Date.now() + 60000 } },
    targets: [],
    status: 'Ready',
  };
  feedback.update(state);
  expect(document.getElementById('flight-upgrade')?.textContent).toContain('6 charges');
  feedback.update({ ...state, pilot: { alive: true, laserUpgrade: { charges: 6, expiresAt: 0 } } });
  expect(document.getElementById('flight-upgrade')?.hidden).toBe(true);
  feedback.update({ ...state, pilot: { alive: false } });
  expect(document.getElementById('flight-feedback')?.hidden).toBe(true);
  feedback.dispose();
});
