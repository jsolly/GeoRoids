# First paint review — #419 (prod)

## Passes

- Hairline outline ships; faction tint reads (local teal / bot amber)
- Playfield stars sparse points (not photo mush in-game)
- Shots are cream points, not disc blooms
- No DEBUG yellow; no giant centered score
- HUD corner-quiet; radar hairline

## Drifts vs beauty bar (elegant phosphor, not brutal)

1. Title still photo starfield + Freepik credit — clash with in-play void; kill credit; prefer sparse points or calm void on title too.
2. Enter Game = solid bright green filled button — modern UI, not vector DNA; outline / phosphor treatment + accent_ui or health tick, not glossy fill.
3. In-play still reads austere/brutal — bump soft phosphor glow slightly (still ≤ stroke); keep hairline.
4. Shot almost invisible as a single pin — prefer short cream segment `#FDE68A` with soft capped glow for beauty + readability.
5. Score digit still a bit loud top-left — smaller phosphor `#E2E8F0`.
6. Always-on ship name labels add clutter — fade unless nearby / damage / settings.
7. Freepik / version watermark in play — hide version in prod play; no stock credits on canvas.

## Priority for next visual pass

1. Title: void + sparse points; vectorize Enter control; kill Freepik credit
2. Shot: short cream segment + soft glow
3. Slightly richer phosphor on ships (elegant, not CRT grit)
4. Quieter score + optional name fade
