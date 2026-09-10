# Contour timing comparison

The repeated browser comparison is inconclusive for frame smoothness. The median
paired reduction in frames over 25 ms was 0.88 percentage points; the largest
baseline-pair difference was 17.99 points. No graphics reduction was enabled.
The separate [deterministic work measurement](frame-work-results.md) still proves
98.63% fewer contour endpoint reads per frame, with matching draw calls and final pixels.

## Conditions and evidence

Apple M3, Darwin 25.6.0, Node 24.16.0, Chromium 153.0.8010.12, SwiftShader software
rendering; portrait touch viewport, device DPR 3, CPU slowdown 4, clean network,
seed 42 combat, native DPR and full glow. Each session warmed up for 30 seconds
and measured for 330 seconds. Three baseline pairs preceded three alternating
baseline/candidate pairs. These results do not establish phone GPU performance.

| Session | Foreground seconds | Frames >25 ms | Frame p99 ms | CPU p95 ms | Input p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| aa-1-a | 329.58 | 29.98% | 33.40 | 3.00 | 4.20 |
| aa-1-b | 328.26 | 47.97% | 49.90 | 3.30 | 4.30 |
| aa-2-a | 329.58 | 46.35% | 49.90 | 3.30 | 4.50 |
| aa-2-b | 329.58 | 42.03% | 33.50 | 3.30 | 4.40 |
| aa-3-a | 327.87 | 43.00% | 33.50 | 3.20 | 4.20 |
| aa-3-b | 329.22 | 39.78% | 33.50 | 3.30 | 4.20 |
| ab-1-a | 328.70 | 20.31% | 33.40 | 2.70 | 4.30 |
| ab-1-b | 328.63 | 20.58% | 33.40 | 2.40 | 3.60 |
| ab-2-a | 330.01 | 20.54% | 33.40 | 2.70 | 4.10 |
| ab-2-b | 329.19 | 19.66% | 33.40 | 2.40 | 3.80 |
| ab-3-a-retry-1 | 329.33 | 24.27% | 33.40 | 2.70 | 3.70 |
| ab-3-b-retry-2 | 328.02 | 18.79% | 33.40 | 2.40 | 3.50 |

The largest A/A differences were 16.50 ms for frame p99, 0.30 ms for CPU p95,
and 0.10 ms for input p95. The candidate did not regress those metrics beyond
baseline variation, but did not meet the absolute frame target. Treat these
values as descriptive reference observations, not CI warnings or failure limits.
Live combat populations, respawns and game-over recovery vary between sessions;
workload distributions and phase ledgers remain in the raw comparison evidence.

Workload review found five humans and two bots throughout the paired runs. Median
asteroid totals were 70/71, 71/72 and 73/73 for baseline/candidate; median visible
asteroids were 4/5, 5/5 and 5/5. Median projectile totals were 14 in all six runs,
with three visible centers. Tail populations and recovery counts differed, so
these live sessions are not deterministic replay. Recovery-skipped slots were
6/6, 0/3 and 3/7. These differences reinforce the inconclusive timing result.

## Recording limitations

Two attempts failed because browser game-over overlapped a peer fixture reset.
Both failed reports are retained: `contour-reportonly-ab-3-a.json` and
`contour-reportonly-ab-3-b-retry-1.json`. The final pair uses baseline retry 1
and candidate retry 2. Performance summaries describe qualifying sessions;
they do not prove benchmark recovery reliability. Subsequent changes check live
transports before world mutation and detect departures while waiting for baseline
acknowledgments. See the [implementation evidence](mobile-implementation-status.md)
for recovery checks; these historical timing reports retain their original source.

The client temporarily cleared its server release during respawn. Validation
retains those unknown intervals explicitly and requires matching known identities
immediately before and after, plus matching measured server-health identities.
Actual release changes and unwitnessed gaps fail validation. Raw reports were
not modified. Source/build/environment and workload checks remain enabled.

## Artifact receipt

Raw paths are relative to `.performance/mobile/`. The manifest is
`contour-reportonly-manifest.json`; the result is
`contour-reportonly-comparison.json` with SHA-256
`ddaa91c15ab2762a436605d388d0d8e880a28bda3eed1c36923fa34fb3690b96`.

| Raw session | SHA-256 |
| --- | --- |
| `contour-reportonly-aa-1-a.json` | `19565645bdec3b636e7e0c757520bb6d7bed601b41705e099404fbd0a6d8d373` |
| `contour-reportonly-aa-1-b.json` | `f94eceb745e421c8d381ba7ff3d89d3dbc82717f091bfafc5a9db611c9e1d05a` |
| `contour-reportonly-aa-2-a.json` | `09ac506d7d7698e7829dc4e9f361a79cefca93f1c6f316deeebe9c6161bcc44e` |
| `contour-reportonly-aa-2-b.json` | `97e3914a0747f175b39b4324779e02d01ced44234e64db554c65d2b39f50897b` |
| `contour-reportonly-aa-3-a.json` | `5ac80d1fbbd3fffc9789ea100bdf103c25f0eda1e7ccedd2602e9ada51355fce` |
| `contour-reportonly-aa-3-b.json` | `042a313ae7b7d9520ba42ef7f25ca1efe5983367c632603db60ccddef9ba93c7` |
| `contour-reportonly-ab-1-a.json` | `ce1d6b9b3ba95f22b2d438f91d635a66937c8b3997d0df82fda75cf4be8bd4c3` |
| `contour-reportonly-ab-1-b.json` | `81d5cdb09d81e321a70ca192b5c103152f0d604c6b49e7118ed08b100790349e` |
| `contour-reportonly-ab-2-a.json` | `752adcc45d1dbbfab13bbe35670677bb6fecef76b64e57f98622e7fc6e9ddd8a` |
| `contour-reportonly-ab-2-b.json` | `7fcef6dead3abe129a19ddb70ae2ffc9c236c7f852f6b598deb7f4d45e57cab0` |
| `contour-reportonly-ab-3-a-retry-1.json` | `df2d4253bec12609980a890b42448bceb8087c7122db2cab720bd0eb3649f3b1` |
| `contour-reportonly-ab-3-b-retry-2.json` | `89c073f47162008a5378d8f96d3382e79bff90b4c5fbcf764a0bd9e569dcaf2d` |
