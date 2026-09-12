# Contour label width reuse

The renderer now measures each visible elevation string once per drawing
context and terrain, using its fixed font. It keeps the labels, backgrounds,
positions and glow unchanged. Replacing the terrain or font replaces the width
map; the weak context key does not keep a discarded canvas alive.

This is a small saving. The current Chromium trace attributes 49.673 ms of
sampled self time to label `measureText` over a 30.011-second measured window.
That is not a claim that labels cause the reported phone slowdown.

## Isolated comparison

The comparison calls the actual baseline and candidate painters using native
Canvas 3.2.3 on Node 24.16.0. Seed-42 terrain and an orbiting camera are identical
between arms. Each run has 300 warmup frames and 1,800 measured frames. Three
A/A controls and three alternating A/B pairs cover each viewport.

| Viewport | Baseline total | Candidate total | Median paired reduction | Saving per frame | Measurement calls A / B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 390×844 portrait | 418.96 ms | 303.58 ms | 27.54% | 0.064 ms | 11,300 / 1 |
| 844×390 landscape | 422.59 ms | 310.36 ms | 26.56% | 0.062 ms | 11,453 / 2 |
| 1280×900 desktop | 1547.21 ms | 1135.70 ms | 26.26% | 0.225 ms | 42,012 / 4 |

Totals are medians. A/A absolute differences reached 64.63, 58.77 and 69.94 ms
respectively, below the paired savings. Every pair produced the same final
pixels. Timings include label drawing and measurement, exclude canvas clearing,
and use synchronous native Canvas rendering. They do not measure browser GPU
completion, whole-game FPS or phone performance.

## Correctness and provenance

All 360 frame comparisons produced identical pixels across three viewports,
two terrain seeds, camera movement, zoom, label spacing, terrain replacement,
canvas resizing and different preexisting context fonts. The painter restores
the caller's context state. The existing two title-terrain scenarios also pass.
The product uses a fixed system monospace font and does not load a webfont for
these labels.

Raw sources, per-frame samples, logs and images are retained in the local
`.performance/contour-label-width/` directory. `correctness.json` and
`timing.json` record source hashes; `summary.json` contains the aggregate
calculation. The baseline is retained both byte-for-byte and with only its
relative imports adjusted for the comparison directory.

Independent review accepted the cache, provenance and scoped timing claim.
Both live mobile-controls and desktop/mobile Wiki browser scenarios pass.
Current gameplay and Wiki captures were inspected. TypeScript, all 1,226 unit
tests and the production build pass after the refreshed Wiki source review.
No rules, articles or demonstrations needed changes for this cache. The [receipt](contour-label-width-receipt.json)
records the retained artifacts.
