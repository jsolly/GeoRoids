# Native Path2D contour path results

The stage 4 adoption screen accepted the native `Path2D` contour submission path for the
current client integration. `src/rendering/contourRenderer.ts` builds a world-space
path from each ordered candidate array and strokes it under the camera transform.
`src/rendering/contourSpatialIndex.ts` retains candidate-array identity for a cell
rectangle and terrain array. The current branch also contains a root-owned,
comment-only spatial-index correction after the measurement run; the receipt records
that current source hash separately from the measured source snapshot.

The production camera returns a positive scale of 1, and the renderer uses indexed
candidates. The scratch comparison includes an invalid-scale baseline fallback;
that experimental fallback is not part of the production painter. `tests/support/TestPath2D.ts` is a test-only command recorder
installed by affected jsdom tests, and this change adds no package or dependency
changes.

## Isolated submission timing

The timing fixture ran in Chromium 153.0.8010.12 on an Apple M3 with accelerated
2D Canvas through ANGLE Metal and device scale factor 3. Each arm used 300 warmup
frames and 1,800 measured frames. Three A/A calibration pairs and three alternating
A/B pairs produced 36 arm records and 64,800 raw samples. `performance.now()`
surrounded only the synchronous painter submission; it did not measure GPU
completion, a browser frame, or FPS. A cold sample includes fresh native
`Path2D` construction, while a warm sample reuses the path.

Pooled warm results show repeated savings against the corresponding A/A drift:

| Viewport | Baseline warm ms/call | Candidate warm ms/call | Saving ms/call | Candidate gain | Maximum A/A drift |
| --- | ---: | ---: | ---: | ---: | ---: |
| Touch portrait | 0.024658 | 0.012576 | 0.012081 | 49.00% | 2.03% |
| Touch landscape | 0.023877 | 0.011777 | 0.012100 | 50.68% | 2.18% |
| Desktop | 0.072089 | 0.026046 | 0.046043 | 63.87% | 2.31% |

Across the three alternating pairs, warm gains were 46.21–52.28% in portrait,
49.51–51.29% in landscape, and 62.17–64.95% on desktop. Including cold samples,
the pooled means were 0.025741 to 0.014519 ms/call in portrait, 0.024907 to
0.013722 ms/call in landscape, and 0.074019 to 0.029352 ms/call on desktop.

Cold rebuilds add a small absolute cost to the candidate arm:

| Viewport | Baseline cold ms/call | Candidate cold ms/call | Candidate cost |
| --- | ---: | ---: | ---: |
| Touch portrait | 0.065278 | 0.085417 | +0.020139 ms (+30.85%) |
| Touch landscape | 0.062500 | 0.084722 | +0.022222 ms (+35.56%) |
| Desktop | 0.144444 | 0.150000 | +0.005556 ms (+3.85%) |

Each arm run has 48 cold frames, with 12 per cold category. The pooled A/B
values use 144 cold frames per arm across three pairs. Each candidate run built
384, 348, and 378 paths in portrait, landscape, and desktop respectively. Chromium's roughly 0.1 ms timer quantization makes the cold
percentages directional rather than precise. The warm savings are the repeated
submission result; the cold construction cost remains part of the tradeoff.

## Correctness and full-scene evidence

The native correctness matrix covered 150 Chromium frames and 150 WebKit frames:
six contexts per browser, with portrait, landscape, and desktop at device scale
factors 1 and 3, and 25 history frames per context. It found zero visible segment
order mismatches, label sequence mismatches, Canvas state mismatches, or pixels
outside contour bounds. Empty candidate paths left zero residual pixels and zero
constructors. The scratch invalid-scale fallback matched the baseline pixels exactly. The
Chromium image differences were 0–2,164 backing-store pixels and the WebKit
differences were 0–225; the differences were confined to contour strokes and
anti-aliasing.

The full-scene fixture exercised the actual GameController update/render path for
23 steps with 24 actor witness records. It included the starfield, boundary, HUD,
pilot, 24 asteroids, 6 loot items, 3 then-current hostile satellites, and 3
pickups. Live play no longer has hostile satellite NPCs. The four
baseline/candidate comparisons changed 52, 60, 29, and 37 pixels for stationary,
cell-crossing, terrain-B replacement, and terrain-A return cases. Every changed
pixel was inside a contour bound, with zero outside-contour pixels. The candidate
constructed 105 native paths. Normalized lifecycle and history witnesses were
byte-equivalent. This fixture establishes localized rendering correctness; it is
not a whole-scene CPU claim.

## Real-game screening

Six Chromium sessions ran the real game with emulated touch at 390x844 CSS pixels,
device scale factor 3, a 1,170x2,532 backing store, full glow, touch controls,
seed 42, and the combat fixture. The Apple M3 used four times CPU slowdown. Each
session had 15 seconds of warmup and 30 seconds of measurement. This is a
desktop emulation run and provides no physical-phone FPS claim.

The pair deltas were:

| Pair | Frame CPU mean | Render mean | Frame CPU p95 | Render p95 |
| --- | ---: | ---: | ---: | ---: |
| A/A, baseline then baseline | +4.36% | +5.36% | -3.57% | -4.17% |
| A/B, baseline then candidate | -0.31% | -1.81% | +3.70% | +9.09% |
| A/B, candidate then baseline | -3.11% | -2.90% | -10.71% | -12.50% |

The A/A row compares the second baseline with the first. Negative A/B values mean
the candidate used less time. All six interval means were approximately 16.666 ms,
with p95 and p99 at 16.7 or 16.8 ms, and no frame interval above 25 ms. The
whole-game mean changes fit inside the A/A mean drift, so this screen shows no
material regression and no independent whole-scene CPU or tail win.

The browser report `warnings` and `errors` arrays were empty, but the captured
server logs contain 15 warning-level `motion_command_rejected` records across the
six sessions: 2, 2, 3, 3, 3, and 2 by run. Fourteen were stale enhanced-motion
pose rejects and one was an envelope-excess reject. The sessions therefore are not
warning-free even though the browser arrays are empty. All four peer clients
completed; local clients acknowledged 867–879 motion states and 49–53 projectiles,
while peers offered 57–59 shots and observed 53–58 authoritative projectiles.

## Summary repair and evidence scope

The first derived timing summary was wrong in two ways: its A/A map overwrote the
first arm under a shared `baseline` key, and its alternating candidate-first
comparison reversed the direction of the gain. The summary was regenerated from
the same raw samples with explicit first and second arms and
`(baseline - candidate) / baseline` normalization. The raw hash stayed
`61a4b035d56fb5c640f6cadd56cb964d327a29074353ad37d08a0080895fe061`. The
incorrect JSON and Markdown summaries remain as historical artifacts beside the
regeneration receipt.

The retained evidence paths are listed in
[contour-path-receipt.json](contour-path-receipt.json). The measurement and
screening files under `.performance/contour-path/` are ignored working artifacts,
so they are listed as code paths rather than Markdown links. This report records
stage 4 adoption and accepted integration. It does not claim the final repository
gate, ship, deploy, a physical-phone result, or a whole-scene CPU win.

For this documentation-only change, tests and timing were not rerun. Scoped docs
Biome and Markdownlint checks are recorded in the receipt.
