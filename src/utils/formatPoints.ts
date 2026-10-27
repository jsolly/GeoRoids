/**
 * Banked points read identically on every player-facing surface.
 *
 * Pinned to en-US rather than the viewer's locale because the client is
 * English-only — every document is `lang="en"` and there is no translation
 * layer. Following the viewer's locale here instead would mean grouping digits
 * one way inside English sentences that spell the units out.
 *
 * `src/wiki/gameReference.ts` is NOT the precedent for that: it pins en-US for
 * the furnace-lot cost at :77 but interpolates the Town Store offer costs raw
 * at :103, so the Wiki reference reads "1000 banked points" where the store
 * panel now reads "1,000". That split is out of this module's reach -- the Wiki
 * reference is generated prose with its own review gate -- and is recorded
 * rather than cited as agreement.
 *
 * The practical hazard is a comma-decimal locale: a furnace plate reading
 * "SCORE 24,000" is twenty-four thousand in en-US and twenty-four in de-DE.
 */
const POINTS = new Intl.NumberFormat('en-US');

export function formatPoints(value: number): string {
  return POINTS.format(value);
}
