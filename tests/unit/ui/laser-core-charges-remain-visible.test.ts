import { afterEach, expect, test } from 'vitest';
import { LaserUpgradeReadout } from '../../../src/rendering/hud/LaserUpgradeReadout';

afterEach(() => document.body.replaceChildren());

test('core pickup reports charges and disappears on expiry, depletion or session reset', () => {
  const readout = new LaserUpgradeReadout(document.body);
  const upgrade = { charges: 6, expiresAt: Date.now() + 60000 };
  readout.update(upgrade);
  expect(document.getElementById('flight-upgrade')?.textContent).toContain('6 charges');
  readout.update({ ...upgrade, charges: 2 });
  expect(document.getElementById('flight-upgrade')?.textContent).toContain('2 charges');
  for (const empty of [{ ...upgrade, expiresAt: 0 }, { ...upgrade, charges: 0 }, undefined]) {
    readout.update(empty);
    expect(document.getElementById('flight-upgrade')?.hidden).toBe(true);
  }
  expect(
    document.querySelector(
      '#flight-upgrade button, #flight-upgrade input, #flight-upgrade [tabindex]'
    )
  ).toBeNull();
});
