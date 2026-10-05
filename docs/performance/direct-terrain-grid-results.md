# Direct terrain grid results

The contour pipeline now prepares row and column coordinates, octave lattice
indices/fades, and passage offsets/widths once per axis, then fills one Float64
height grid. Point sampling and the grid share the noise interpolation and
height shaping rules; passage primitives remain owned by `passages.ts`.
Marching squares, contour ordering and the existing patch cache are unchanged.
At grid 96, job-owned axis arrays add 17,072 bytes beside the existing
75,272-byte height grid. Nothing new is retained between jobs.

## Correctness and verification

The focused suite passed 37 tests: 25 complete grid/extrema comparisons,
seven ordered-contour witnesses and five independent point/gradient witnesses.
The witnesses were generated from the frozen four-module implementation at
`5cdaeedad8db22f5925dd4cdc176caa606bfc5be`, before refactoring; numeric encodings
retain signed zero. Another 19 existing contour, passage and patch-cache tests
passed. TypeScript checks and unused-code checks passed.

Browser observation independently matched complete height grids, extrema,
ordered contours and four ordered spatial queries in all 21 patch cases.
The matrix covers three seeds, spawn, region crossing, actual generated
landmarks, axis/diagonal rim intersections and wider scan-sized kernels.
Unit cases additionally cover translated worlds, fractional bounds, a small
grid, eager small-world extraction and fully exterior patches.

The scoped Wiki review accepts only the three changed terrain sources. Terrain
travel, contour lock, scan controls and the existing demonstration remain
accurate; no article or media change is needed.

## Calibrated CPU comparison

Run `benchmarks/terrain-grid/run.mjs` for the frozen baseline versus the actual
production extraction plus a fresh spatial index. Fields are created outside
timing. The driver retains every input, compiled-module identity, raw duration,
control pair and cleanup receipt. It uses fresh observation/timing contexts,
native Chromium/GPU, CPU slowdown 4 and alternating baseline/candidate arms
between bracketing baseline/baseline controls.

The first production run used ten warmups and twelve calls per arm with three
pairs in each phase. Its host load averaged roughly 40–68 runnable jobs and
several unrelated browser/test processes were active. Only 3/18 normal cases
and 0/3 scan-sized cases beat every bracketing control in every candidate pair.
This run is retained as noisy evidence and does not support a speed claim.

The longer-arm repeat qualified 7/18 normal cases and 2/3 scan-sized cases.
The final driver rerun, after adding browser setup deadlines, qualified 10/18
normal cases and 1/3 scan-sized cases. Each qualifying case saves more than its
maximum absolute bracketing control drift in every candidate pair. No qualified
regression was reproduced. The final rerun began at host load 4.43, though
individual controls still reached 18.73% drift.

Qualified workloads support roughly 14–16% less complete-job CPU. The original
33.48%/26.71% prototype reductions and 17/18 + 3/3 qualification coverage were
not reproduced. The whole-cohort ratios below are descriptive: unqualified
cases prevent interpreting them as a precise, universal speedup.

| Collection | Warmups/calls | Normal qualified | Scan qualified | Normal ratio | Scan ratio |
| --- | --- | --- | --- | --- | --- |
| Initial, contended | 10/12 | 3/18 | 0/3 | 1.177× | 1.307× |
| Long arms, contended | 20/100 | 7/18 | 2/3 | 1.152× | 1.156× |
| Final driver | 10/12 | 10/18 | 1/3 | 1.182× | 1.186× |

These measurements describe synchronous patch CPU work on this desktop.
They do not establish game FPS, physical-phone performance, battery savings,
slow-link freshness or fewer visible stalls. The 4096-radius cases remain
scan-sized kernels without a measured viewport-to-radius mapping.

## Final-run case evidence

All values below use complete extraction plus a new spatial index. Savings are
fractional baseline-to-candidate differences per pair. A case qualifies only
when its worst candidate pair beats its largest absolute A/A control drift.

| Case | Worst saving | Maximum control drift | Qualified |
| --- | --- | --- | --- |
| spawn-42 | 11.99% | 4.07% | Yes |
| crossing-42 | 14.33% | 6.70% | Yes |
| wide-scan-42 | -3.47% | 7.75% | No |
| rim-42 | 13.33% | 18.73% | No |
| landmark-42-5 | 6.89% | 8.54% | No |
| landmark-42-0 | 6.20% | 15.70% | No |
| diagonal-rim-42 | 7.84% | 8.70% | No |
| spawn-8306717 | 7.46% | 17.36% | No |
| crossing-8306717 | 6.84% | 11.05% | No |
| wide-scan-8306717 | 3.01% | 10.29% | No |
| rim-8306717 | 13.76% | 12.82% | Yes |
| landmark-8306717-0 | 8.48% | 14.58% | No |
| landmark-8306717-4 | 8.79% | 12.67% | No |
| diagonal-rim-8306717 | 13.19% | 2.52% | Yes |
| spawn-123456789 | 13.78% | 3.34% | Yes |
| crossing-123456789 | 15.21% | 5.17% | Yes |
| wide-scan-123456789 | 13.32% | 6.16% | Yes |
| rim-123456789 | 16.53% | 1.92% | Yes |
| landmark-123456789-4 | 12.64% | 2.21% | Yes |
| landmark-123456789-3 | 14.42% | 1.73% | Yes |
| diagonal-rim-123456789 | 15.24% | 5.30% | Yes |

Every successful collection matched all 21 exact cases, retained all raw calls,
verified source identity after cleanup and closed its owned resources. The
failed parser-setup receipt is retained too. Raw reports, generated frozen
sources and their summaries are preserved outside the removable worktree in
the task's `direct-terrain-grid-implementation/terrain-grid/` artifact directory.
Report hashes bind these results:

- `run-FsJt64/report.json`: `36989598a0794895d8e9dcbe0f68219bd7865ce9a1cbed5b3b863c72e827a766`.
- `run-usejyf/report.json`: `7ee9f8e3c91c97e508911eac08ea6ff00b757a899202e5487d3943a870389e39`.
- `run-BLep6T/report.json`: `33c68fbcf0fcc409c6f12ecca9614e226076121c525fb9614d4d58ac79b31033`.

## Release acceptance

The full shipping gate must cover unit tests, integration, native rendered
contour/scan flows, frame work and constrained clients. Ship review also requires
unchanged checkout fingerprints and disposition of the benchmark deadline
finding. The ship receipt records the actual gate, PR CI, independent client
and required server release, production-smoke result and resource cleanup.
No terrain, world persistence or protocol migration is required.
