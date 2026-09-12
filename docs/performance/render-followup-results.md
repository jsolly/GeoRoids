# Remaining renderer screens

Measured September 12, 2026. None of the three timed candidates was adopted.
The existing contour-label, viewport-query, and leaderboard implementations
remain in production source. These screens follow the accepted contour path and label-width caches;
they do not replace those earlier results.

## Contour-label spatial query

The candidate indexed 704 immutable anchors in 256-world-pixel cells, visited
only cells overlapping the viewport, and sorted candidates into the original
paint order. It preserved the actual gameplay and title-screen callers.

Correctness passed 263 deterministic frames and 27,688 exact Canvas command
pairs. Native Chromium passed six viewport/DPR contexts, 216 lifecycle frames,
432 Canvas-state checks, and 78 byte-exact pixel comparisons. Every compared
frame contained painted labels. This included title spacing 520, its actual
viewport-derived scales, resizing, cell boundaries, teleports, and terrain
identity changes.

The fixed timing screen completed 36 arms: two A/A and four alternating A/B
pairs per viewport. Each arm used 180 warmup draws and 480 samples amplified
over eight painter calls. Chromium 153 used Apple M3 Metal, DPR 3, and no CPU
throttling. The clock measured synchronous Canvas submission, not GPU completion.

| Viewport | Matched warm change | Mean saving per draw | Largest A/A drift |
| --- | ---: | ---: | ---: |
| Portrait | 6.4–9.5% faster | 0.00055 ms | 1.44% |
| Landscape | 3.0–8.2% faster | 0.00036 ms | 1.13% |
| Desktop | 11.0–22.0% slower | -0.00296 ms | 6.43% |

The candidate failed the predeclared all-viewport gate. Both touch viewports
failed the 300-draw cold-cost break-even limit; portrait also missed the scale
category limit. Desktop was slower in every matched overall comparison.
Retained heap increased by roughly 91–95 KiB, within the 2 MiB ceiling.
The runner exited zero because the complete result was successfully collected;
the recorded performance verdict is **fail**. No retry was used to seek a pass.

## Reusing viewport media queries

The candidate retained two MediaQueryList handles per live window and
matchMedia function, then read their live matches on every call. Dimensions,
touch counts, and safe-area computed styles still came from the current draw.
Replacing or removing the factory invalidated the retained handles.

Native Chromium correctness passed portrait, landscape, and desktop contexts,
including real native-query transitions across resize, factory replacement and
removal, multiple window-like inputs, and same-turn safe-area style changes.
Twenty warm candidate queries created zero media-query objects; control created
40. Returned viewport state and complete layout objects matched.

The fixed CPU4 screen completed 72 fresh-browser records: three A/A and three
alternating A/B pairs for the query and full HUD-layout paths in each viewport.
Each used 300 warmup calls and 120 blocks of 50 measured calls. All checksums,
viewport queries, and layouts matched; browser diagnostics were empty.

The full layout call saved 0.00338–0.00385 ms per touch draw, beyond its
0.00025–0.00063 ms A/A variation. That is a measurable local saving, but it
misses the predeclared 0.02 ms minimum contribution. The result is **reject**:
the change adds caching state for a few microseconds per draw. It is not a
meaningful response to the reported phone slowdown. Desktop did not regress.

## Leaderboard text widths

The candidate cached up to 256 measured widths per Canvas context, keyed by
font and exact text. Membership, sorting, fitted names, bot suffixes, and paint
order stayed unchanged. Native correctness passed all three viewports with
byte-exact pixels, identical text calls and styles, restored caller state,
nonempty paint, Unicode, changed names/scores/widths/fonts, separate contexts,
and eviction. Two failed attempts remain recorded. The first lost its failing
proof before assertion; the second showed a fixture expectation missing the
existing `(bot)` suffix. Both implementations already rendered the same pixels.
The corrected proof retains nine expected browser readback advisories separately.

The CPU4 timing screen completed 36 fresh-browser arms, three A/A and three
alternating A/B pairs per viewport. Each used 300 warmup draws and 120 blocks
of 64 direct leaderboard draws. Native text-call counting ran outside the clock.
The fixed gate required a mean saving of at least 0.02 ms per draw beyond the
largest A/A difference, plus at least half the text measurements, in every view.

| Viewport | Mean saving per draw | Largest A/A difference | Warm native measurements |
| --- | ---: | ---: | ---: |
| Portrait | -0.00405 ms | 0.00466 ms | 29 → 0 |
| Landscape | -0.00415 ms | 0.00126 ms | 23 → 0 |
| Desktop | -0.00230 ms | 0.00263 ms | 34 → 0 |

The complete result is **reject**. Removing native calls did not reduce the
complete draw cost. Every touch pair was slower; desktop had one faster pair
and two slower pairs. No view reached the fixed mean-saving floor. No retry
or product integration followed this result.

## Buffered remote hulls

A separate source-level prototype delayed remote hulls by 100 ms while keeping
projectiles on the existing authoritative timeline. Its renderer switched to
current hull positions whenever a remote shot was active, then returned to the
buffered position when the shot disappeared. The static witness and independent
source review identify a forward/backward hull jump around a short-lived shot.
Removing that fallback would separate a current bolt from its delayed shooter.

This hull-only candidate is rejected without a runtime rollout. The witness is
an unexecuted code-level argument, not a measured game result. A broader delayed
projectile timeline also needs an explicit policy for shots removed before their
delayed birth can render. Continue that architectural investigation only if the
current 30 Hz compression comparison leaves a material delivery bottleneck;
consider a lower or zero presentation delay before adding another timeline.
The documented 20 Hz adoption gate still requires physical-phone quality proof.

## Evidence and limits

Raw artifacts remain in the working tree under these ignored directories:

- `.performance/contour-label-query/attempts/timing-20260912T211116.046350Z-60881`
- `.performance/viewport-query/attempts/timing-20260912T211247.950651Z`
- `.performance/leaderboard-width/attempts/timing-20260912T215219.618236Z`

The [receipt](render-followup-receipt.json) binds source, correctness, raw timing,
and direct command results. All three commands completed with owned-server cleanup.
Coarse browser-clock samples are amplified and evaluated through matched means;
individual zero-duration samples are preserved. These experiments do not establish
physical-phone FPS, thermal behavior, or total-game speed.

No Wiki behavior changed because none of these candidates was integrated.
