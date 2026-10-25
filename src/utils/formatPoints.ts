/**
 * Banked points read identically on every player-facing surface.
 *
 * Pinned to en-US rather than the viewer's locale because the client is
 * English-only — every document is `lang="en"` and there is no translation
 * layer — and `src/wiki/gameReference.ts` already pins en-US for the same
 * quantities. Following the viewer's locale here instead would mean grouping
 * digits one way inside English sentences that spell the units out.
 *
 * The practical hazard is a comma-decimal locale: a furnace plate reading
 * "SCORE 24,000" is twenty-four thousand in en-US and twenty-four in de-DE.
 */
const POINTS = new Intl.NumberFormat('en-US');

export function formatPoints(value: number): string {
  return POINTS.format(value);
}
