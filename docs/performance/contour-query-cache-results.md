# Reusing contour queries while the camera moves

The September 12 candidate retains the last queried cell rectangle and its
ordered segments for each terrain level. Camera movement within those cells
reuses the result. The renderer still projects endpoints and applies its exact
visibility predicate every frame. Geometry, stroke order, labels and quality
settings are unchanged.

The current client trace identified contour lookup as a useful target, at about
501 ms sampled self CPU within a 30-second measured window. This is attribution
from desktop Chromium with CPU slowdown, not a phone measurement. The trace and
its exact bundles are recorded in the
[rendering report](render-attribution-results.md).

## Isolated query comparison

The fixture generates the game's actual seed-42 terrain: 18 levels and 23,790
segments in a radius-2,800 arena. Each arm runs 600 warmup frames and 1,800
measured frames at scale 1.15. The orbit camera travels around an 800-unit circle
over 1,800 frames. Stationary and per-frame teleport cases test the cache's best
and worst reuse conditions. Node 24.16.0 runs on the local Mac; these are query
CPU measurements, not render or frame-rate measurements.

Three A/A controls and three alternating A/B comparisons retain every per-frame
sample. The smooth-motion results exceed the largest corresponding A/A absolute
difference:

| Viewport | Baseline median total ms | Candidate median total ms | Median paired reduction | Reused queries |
| --- | ---: | ---: | ---: | ---: |
| Portrait, 390×844 | 50.93 | 2.45 | 95.24% | 97.44% |
| Landscape, 844×390 | 56.87 | 2.65 | 95.34% | 97.46% |
| Desktop, 1280×900 | 151.44 | 5.79 | 96.02% | 97.49% |

Totals cover all 1,800 measured frames. Stationary queries improved by
97.88–99.54%. Teleporting each frame produced no reuse and added 0.07–2.50% query
cost. The largest median paired increase was 1.97 ms over 1,800 frames, about
0.0011 ms per frame. That small miss-path cost is accepted in exchange for the
measured normal-motion saving. This does not predict a percentage FPS gain.

## Correctness and retention

All 291,600 fixture queries returned exactly the baseline's ordered segments,
including changing camera positions and viewports. The focused tests also cover
padded edges, crossing lines, negative cells, zoom, offscreen queries, invalid
scale and replacement terrain. Previously returned arrays remain valid after
the camera enters another cell rectangle.

Twelve observations in the compiled game-renderer fixture cover two unchanged
baseline and two candidate runs at desktop, portrait and landscape widths.
Every arm produced equal game outcomes, per-frame Canvas work and final pixel
hashes. This short stationary fixture proves preserved rendering for that scene;
it does not establish sustained frame-rate behavior or moving-camera pixels.
The exact query comparison separately covers moving cameras.

The cache retains one result per contour level, under the existing terrain-array
WeakMap. New rectangles replace the retained result. Replaced terrain can be
collected. There is no camera-history cache or mutation of published results.

The four focused unit scenarios and TypeScript check pass. The Wiki's terrain
behavior is unchanged. Combined desktop/mobile gameplay and Wiki browser checks, 61 focused scenarios
and the full repository gate passed for the combined candidate.

## Reproduction evidence

The [receipt](contour-query-cache-receipt.json) records source, fixture, raw
sample, test and rendering-result hashes. Local ignored artifacts are under
`.performance/contour-cache/`; the baseline source was retained before editing.
Run the isolated comparison from
`/Users/johnsolly/code/GeoRoids-worktrees/mobile-performance-and-pace`:

```sh
node --import tsx .performance/contour-cache/bench.ts
```

The exact-renderer check is `render-check.ts` in that directory. It temporarily
selects each source arm and restores the candidate in `finally`; it must run
without concurrent edits, builds or benchmarks. Raw timing is descriptive and
does not create a numeric CI failure threshold.
