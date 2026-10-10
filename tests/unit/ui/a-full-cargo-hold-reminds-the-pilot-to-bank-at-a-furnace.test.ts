import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { cargoCapacity } from '../../../shared/economy';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { NetworkManager } from '../../../src/network/networkManager';
import { resetCargoFullHint, syncCargoFullHint } from '../../../src/ui/cargoFullHint';
import {
  CARGO_FULL_HINT,
  CARGO_FULL_REPEAT_MS,
  CARGO_FULL_SHOW_MS,
} from '../../../src/ui/constants';
import { hideFieldHints, readFieldHints } from '../../../src/ui/fieldHint';

const shown = () => readFieldHints().some((hint) => hint.id === 'cargo-full-hint');

beforeAll(() => {
  const network = NetworkManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
  document.body.classList.add('in-play');
  PlayerManager.getInstance().createLocalPlayer('hauler');
});

beforeEach(() => {
  resetCargoFullHint();
  hideFieldHints();
});

afterAll(() => {
  document.body.classList.remove('in-play');
  hideFieldHints();
  resetCargoFullHint();
});

test('a Hauler whose hold fills sees a brief bank reminder that returns every few minutes', () => {
  const pilot = PlayerManager.getInstance().getLocalPlayer();
  if (!pilot) {
    throw new Error('Missing local pilot');
  }
  pilot.cargo = cargoCapacity(pilot.ship.kitId) - 35;
  syncCargoFullHint(10_000);
  expect(shown()).toBe(false);

  pilot.cargo = cargoCapacity(pilot.ship.kitId);
  syncCargoFullHint(12_500);
  expect(shown()).toBe(true);
  expect(readFieldHints().find((hint) => hint.id === 'cargo-full-hint')?.text).toBe(
    CARGO_FULL_HINT
  );
  syncCargoFullHint(12_500 + CARGO_FULL_SHOW_MS + 1);
  expect(shown()).toBe(false);

  // Still full: quiet until the repeat interval, then briefly back.
  syncCargoFullHint(12_500 + CARGO_FULL_REPEAT_MS / 2);
  expect(shown()).toBe(false);
  syncCargoFullHint(12_500 + CARGO_FULL_REPEAT_MS);
  expect(shown()).toBe(true);
});

test('banking the cargo clears the reminder and a quick refill waits for the interval', () => {
  const pilot = PlayerManager.getInstance().getLocalPlayer();
  if (!pilot) {
    throw new Error('Missing local pilot');
  }
  pilot.cargo = cargoCapacity(pilot.ship.kitId);
  syncCargoFullHint(40_000);
  expect(shown()).toBe(true);
  pilot.cargo = 0;
  syncCargoFullHint(41_000);
  expect(shown()).toBe(false);
  pilot.cargo = cargoCapacity(pilot.ship.kitId);
  syncCargoFullHint(70_000);
  expect(shown()).toBe(false);
  syncCargoFullHint(40_000 + CARGO_FULL_REPEAT_MS);
  expect(shown()).toBe(true);
});

test('a new runtime resets the full-hold reminder clock and leaving play hides it', () => {
  const pilot = PlayerManager.getInstance().getLocalPlayer();
  if (!pilot) {
    throw new Error('Missing local pilot');
  }
  pilot.cargo = cargoCapacity(pilot.ship.kitId);
  syncCargoFullHint(100_000);
  expect(shown()).toBe(true);
  resetCargoFullHint();
  syncCargoFullHint(100_001);
  expect(shown()).toBe(true);
  syncCargoFullHint(100_001 + CARGO_FULL_SHOW_MS - 1);
  expect(shown()).toBe(true);
  syncCargoFullHint(100_001 + CARGO_FULL_SHOW_MS);
  expect(shown()).toBe(false);
  document.body.classList.remove('in-play');
  syncCargoFullHint(100_001 + CARGO_FULL_REPEAT_MS);
  expect(shown()).toBe(false);
  document.body.classList.add('in-play');
});
