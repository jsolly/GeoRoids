import { cargoCapacity } from '../../shared/economy';
import { PlayerManager } from '../entities/player/PlayerManager';
import { CARGO_FULL_HINT, CARGO_FULL_REPEAT_MS, CARGO_FULL_SHOW_MS } from './constants';
import { setFieldHint } from './fieldHint';

let shownAt = Number.NEGATIVE_INFINITY;

/** Remind when the hold fills, then every few minutes while it stays full. */
export function syncCargoFullHint(now: number = performance.now()): void {
  const pilot = PlayerManager.getInstance().getLocalPlayer();
  const full =
    pilot !== null &&
    document.body.classList.contains('in-play') &&
    pilot.cargo >= cargoCapacity(pilot.ship.kitId);
  if (full && now - shownAt >= CARGO_FULL_REPEAT_MS) {
    shownAt = now;
  }
  setFieldHint('cargo-full-hint', full && now - shownAt < CARGO_FULL_SHOW_MS, {
    text: CARGO_FULL_HINT,
  });
}

export function resetCargoFullHintForTests(): void {
  shownAt = Number.NEGATIVE_INFINITY;
}
