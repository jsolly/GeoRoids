/**
 * Temporary in-game danger music.
 *
 * Gameplay (the upcoming threat feature) should import these from this module:
 *
 * ```
 * import { pushMusicThreat, clearMusicThreat } from '../audio/musicThreat';
 * ```
 *
 * Pair every `pushMusicThreat()` with a later `clearMusicThreat()`. Counts
 * nest so overlapping threats do not fight. Music off keeps the count but
 * plays silence. Leaving the playfield zeros the count so the title bed
 * cannot inherit a stale threat, and re-entering play restores the normal
 * in-game bed until something pushes again.
 *
 * Expected files: `public/music/danger-bed.ogg` and `public/music/danger-bed.mp3`
 * (Iso Threat, Suno `31b6f7b6`). Missing or failed decode falls back to a
 * slightly more intense in-game bed.
 */

let threatCount = 0;
let onChange: (() => void) | undefined;

export function registerMusicThreatListener(listener: () => void): void {
  onChange = listener;
}

export function isMusicThreatActive(): boolean {
  return threatCount > 0;
}

/** Begin or stack a danger bed. Pair with `clearMusicThreat()`. */
export function pushMusicThreat(): void {
  threatCount += 1;
  onChange?.();
}

/** Pop one threat. Extra clears are ignored so mismatched callers stay silent. */
export function clearMusicThreat(): void {
  if (threatCount === 0) {
    return;
  }
  threatCount -= 1;
  onChange?.();
}

/** Drop every stacked threat. Used when the player leaves the playfield. */
export function resetMusicThreats(): void {
  if (threatCount === 0) {
    return;
  }
  threatCount = 0;
  onChange?.();
}
