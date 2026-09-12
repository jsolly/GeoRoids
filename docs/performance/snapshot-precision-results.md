# Snapshot precision screening

Four-decimal world kinematics save 15.9% of mixed-stream snapshot bytes while
preserving every player/bot entity field. The isolated candidate now passes
browser authority/recovery checks, 1,228 unit tests and the production build.
Independent review accepts bandwidth, delivery, authority and recovery across
twelve short network/application runs. A complete fixed-world browser replay
failed the strict CPU/noise gate. Independent review recommends the explicit
bandwidth/CPU tradeoff, and four-decimal world coordinates are now integrated.
The failed gate remains failed; no CPU speedup is claimed.

## What changes

The candidate rounds selected world positions, velocities and orientations in
the encoder's detached snapshot. All player/bot entity fields remain exact,
including local motion, angle and handoff anchors. The server rejects small
motion-envelope excesses, so those fields cannot safely use a generic rounding
pass. IDs, ordering, counters, resources, timers, asteroid shape and spin rate,
and unknown fields also remain exact. Server simulation never receives the
rounded state. The decoder and JSON protocol stay unchanged.

The original capture still copies and validates the input. A guarded three- or
four-decimal transform then maps only validated finite scalars to finite values.
It preserves integers and values above the safe multiplication cutoff. It does
not repeat full validation after that operation. The first implementation did
repeat validation and increased all-keyframe server CPU by about 11%; that
failed candidate is retained separately.

## Captured workload and correctness

The current GameEngine fixture produced 300 measured broadcasts after 60 warmup
and 600 measured simulation ticks. It has ten humans, two bots, 66–84 asteroids,
five or six satellites, two pickups, 8–74 player shots and 0–34 satellite shots.
Its normal stream has four keyframes and 296 deltas. The alternate stream sends
every state as a keyframe to expose join/recovery costs. These are controlled
combat worlds with an immediate transport sink, not a production replay.

Checks cover 1,800 reconstructed states, 6,486 accepted/malformed comparisons
across 162 field paths, 32 representable cutoff/zero/subnormal/extreme cases,
eight unknown-field delta/recovery states and ten invalid precision values.
They preserve exact counters, energy bounds, references and unknown vector
fields, and reject malformed packets without damaging the retained baseline.

The actual broadcaster also ran with each candidate encoder. All 300
authoritative world-plus-projectile hashes, initial/final outcomes, population
trajectories and shot admission counts match the exact arm. UUID substrings
are normalized for comparison; numerical state is not rounded. Additional
checks deliberately mutate detached ship positions/velocities, motion anchors,
asteroid positions/velocities and offsets, then confirm the live engine is
unchanged. The temporary protocol edit was restored and its hash verified.

## Paired Node measurements

Each mode has three A/A pairs and three alternating exact/candidate pairs per
precision. Each arm warms 300 messages and measures 600. Server time includes
capture, validation, rounding, diff and serialization. Client time here is JSON
parse plus snapshot decode/retention; it excludes application to game objects.
Percent changes below are median paired total changes. Negative is less work.

| Mode / precision | Stream bytes | Server time | Client parse/decode | Combined pipeline |
| --- | ---: | ---: | ---: | ---: |
| Deltas / four decimals | -15.94% | -6.24% | -1.47% | -4.74% |
| Deltas / three decimals | -17.53% | -4.74% | -0.38% | -3.82% |
| Keyframes / four decimals | -11.26% | -3.54% | -1.46% | -2.20% |
| Keyframes / three decimals | -12.19% | -2.62% | -1.56% | -2.06% |

Mixed-stream messages average 28,479 bytes exact, 23,938 with four decimals,
and 23,487 with three. Byte savings are deterministic for this captured stream.
The standalone rounding stage costs a median 0.0100 ms for four decimals and
0.0086 ms for three.

CPU savings require more caution. Mixed-stream A/A pipeline variation reaches
69.43 ms per 600 messages, larger than the paired candidate savings. The first
three-decimal pair is slower. Therefore the table does not establish a reliable
mixed-stream CPU speedup. The keyframe comparisons are more stable: all paired
pipeline savings exceed the largest 3.91 ms A/A variation.

Four-decimal client parse/decode p95 decreases in every pair. Three-decimal
mixed-stream client p95 changes by +3.22% at the median, with one pair +7.46%;
decode alone changes by +6.16% at the median. These observations are retained.
The four-decimal arm is the lead for browser evaluation; the extra 1.59
percentage points of byte reduction do not justify choosing the noisier arm
from these results alone. Neither result is phone FPS.

## Browser and network follow-up

The isolated exact/four-decimal browser pair used a real ephemeral game server.
Each arm admitted 100 eligible shots with distinct non-null projectile
acknowledgments, including rest, sustained movement and Dart boost. Movement
lasted 30.8 and 31.9 seconds; the clients decoded 2,037 and 2,064 snapshots.
Both recorded zero motion rejections, resyncs, reconnects and browser errors.
Extended spawn protection isolates input/shot admission from ambient deaths;
this is not a combat-survival result. Desktop and mobile screenshots retain
readable ships, projectiles, controls, Dart HUD, lives and score.

Canonical real-socket motion, reconnect, boundary/asteroid respawn, Quake
feedback, sustained mobile controls and desktop/mobile Wiki checks pass. One
reconnect fixture initially expected unrounded world coordinates; comparing
with the encoder's wire state fixed it while exact player/engine assertions
remain. The isolated candidate then passed all 1,228 unit tests and build.

The network screen uses M3 Metal Chromium, a 390×844 touch viewport, DPR 3,
CPU slowdown 4, native/full rendering, 15 seconds warmup and 30 measured seconds.
The 5 Mbps lane has one unchanged A/A pair and two alternating A/B pairs.
The clean lane has the same pair count after a targeted follow-up.

| 5 Mbps pair | Exact updates/s | Four-decimal updates/s |
| --- | ---: | ---: |
| A/B | 21.07 | 30.46 |
| B/A | 23.16 | 30.20 |

All twelve runs passed their workload and cleanup checks. Initial fixtures and
source/harness identities were verified, but live populations and recoveries
vary; these are not identical replayed worlds. Browser diagnostics were empty;
raw server warning counts and recovery outliers remain in the local reports.

The first clean pair's snapshot-application p95 changed from 1.0 to 1.1 ms.
The reverse pair changed from 1.1 to 1.0 ms, and unchanged controls varied by the
same 0.1 ms. That does not establish an application CPU improvement or a
repeatable regression. Review found too few keyframes and clock steps larger than the 5% CPU guard.
A fixed-world replay now applies 16,800 measured messages in 840 blocks through
the real browser receiver, with a 0.005 ms timer, CPU slowdown 4, and populated
projectile/manager witnesses. The first timing attempt failed before useful
samples because test-data preparation outlasted transport liveness. Preparation
now runs before browser startup and the test socket answers normal heartbeats;
a fresh correctness proof and independent review passed before timing.

The complete timing run fails the predefined per-phase gate. Full-snapshot
control p95 varies by 7.2% for the complete handler, 8.7% for decode, and 21.6%
for application. Incremental application changes +12.1% in A/B and -13.8% in
B/A. Complete incremental handling changes +0.7% and -2.8%; complete full-state
handling changes -4.4% and -2.8%. All 16,800 messages apply, with no browser
errors or warnings and clean runner shutdown. These are p95 values of
20-message block averages, not individual-message p95 values. The failed gate
and all raw values remain; no CPU speedup or per-phase non-regression is claimed.
Independent review accepts this uncertainty for the demonstrated bandwidth and
delivery benefit. Repeating the same experiment until its control noise happens
to pass would not establish a stronger result. None of these desktop sessions measures
physical-phone FPS, thermal behavior or sustained capacity.

## Evidence

The [receipt](snapshot-precision-receipt.json) identifies current sources,
captured worlds, verification, authority checks and raw timing under
`.performance/wire-precision/`. The first harness attempts incorrectly required
negative-zero preservation across JSON and source insertion order after delta
field reintroduction. Their logs and sources remain. A later expanded fixture
used an invalid collab-tag ID; validation rejected it, and the fixture was
corrected before the final comparison. Final verification and timing use the
same guarded candidate source.

Reproduction instructions are in the scratch README. Independent review passed
the offline four-decimal gate after recomputing raw timing pairs and inspecting
the authority and ownership artifacts. The browser/network artifacts are in
`.performance/wire-precision-browser/` in the isolated
`wire-precision-browser` worktree. The network review identifies only browser CPU attribution as its remaining
gap. The final timing review accepts the disclosed tradeoff while retaining the
failed strict gate. The combined main product passes 11 live cases across mobile
controls, desktop/mobile Wiki, real motion, reconnect and prepared-fixture
recovery. Its unit run passed 1,247 cases and failed only the stale Wiki-review
contract; after the documented review, that contract and production build pass.
The codec/protocol benchmark expectations also now use the selected wire
precision, with separate original-input mutation witnesses and passing API, CLI
and focused unit checks. The final combined shipping gate remains outstanding.
