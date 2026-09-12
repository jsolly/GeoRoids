# Browser rendering attribution, September 12, 2026

## Finding and limits

The old software-browser profiles hid substantial deferred Canvas painting
behind opaque CPU samples. A fresh Chromium trace locates that work in main-thread
layer updates and native path painting after the game's render callback returns.
The GPU-backed Chromium capture uses Apple M3 Metal and behaves differently.
This is evidence about the test environment, not an FPS improvement from game
changes or a physical-phone result.

Both historical diagnostic runs used the production client, seeded five-pilot combat,
390×844 CSS pixels, native DPR 3, full glow, CPU slowdown 4, a clean connection,
15 seconds of warmup and 30 seconds of measurement. Both passed with complete
cleanup, no reported trace data loss, and empty browser error/warning lists.
Gameplay source was identical. Harness revisions and browser execution paths
differ, and the live worlds evolve independently. These are attribution captures,
not a calibrated timing comparison.

| Observation in the profiled run | Headless shell / SwiftShader | Full Chromium / Apple M3 Metal |
| --- | ---: | ---: |
| Frame interval p95 | 33.4 ms | 16.7 ms |
| Intervals above 25 ms | 69.08% | 0.11% |
| Game render submission p95 | 2.8 ms | 2.7 ms |
| Game frame CPU p95 | 3.3 ms | 3.2 ms |
| Input handler-to-render p95 | 5.5 ms | 16.5 ms |
| Retained trace events | 1,408,174 | 2,048,888 |

The software trace recorded 21.66 seconds inside `LayerTreeHost::DoUpdateLayers`
over 1,033 updates, about 21 ms per update. Native `SkCanvas::drawPath` events
accounted for 16.07 seconds. `FireAnimationFrame` accounted for 2.65 seconds.
These are inclusive durations and must not be added together. The Metal trace
recorded GPU-process work as well as main-thread work and 843 CPU profile chunks.
It does not report physical display latency. The input metric also excludes
input time before its JavaScript handler runs.

The screenshot from the software capture was inspected. The ship, projectiles,
contours, HUD and touch controls rendered normally. A final screenshot does not
establish smooth motion or equivalent visible populations throughout the run.

## Repeatable diagnostic path

The production-client runner now accepts `--trace <path>`. It records the
measured phase through CDP, writes a bounded gzip stream, rejects reported trace
data loss, and retains exact loaded same-origin JavaScript responses with hashes.
This permits mapping minified function locations to the actual build. It also
marks `profileRecorded: true`, excluding the report from timing acceptance.
Failure and cleanup errors remain report failures.

The opt-in `--chromium-gpu` flag uses the full Chromium channel with
`--enable-gpu`. It requires observed Canvas, compositing and raster acceleration
and a non-software renderer, then records explicit launch flags and GPU details.
The ordinary runner default remains available as a separate software cohort.
This follows the primary documentation for
[Playwright browser channels](https://playwright.dev/docs/browsers#chromium-new-headless-mode)
and [Chromium GPU support in headless mode](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md).

The [receipt](render-attribution-receipt.json) retains report, trace and bundle
manifest identities. Source revision is `771acd9` plus the pace/path-reuse work.
These captures predate integration of the newer gameplay and CMS manual at
`5d27a1a`. Current-release acceptance requires fresh recordings. The full
repository gate passed after the initial trace support;
the subsequent GPU flag passed compiler/lint checks and its real capture.

## Current-main integration and driver corrections

The implementation now includes `5d27a1a`, current abilities, authoritative
shooting and the CMS manual. The integrated gameplay and final driver changes
passed the full repository gate. Desktop/mobile gameplay, controls and manual
checks are recorded in the [pace report](mobile-pace-results.md).

Two fresh recordings are retained as failures. The first completed its trace
but all four peer pilots offered old-speed shots that current authority rejected.
The driver now uses shared laser speed plus inherited ship velocity. A real
server/socket test observes movement, an admitted shot and the same projectile
ID in the published world; the old-speed mutation fails. This changes offered
combat work, so prior harness recordings are not timing controls for it.

The second capture observed 58–60 authoritative shots per peer but exposed a
measurement-boundary race. While writing the end marker asynchronously, a later
snapshot could move the final arrival time beyond the host end and produce a
negative tail gap. Measurement now closes synchronously before awaiting that
marker. Failed recordings also retain available aggregate intervals instead of
reporting false missing parse/decode/application metrics. The failures and exact
artifacts remain in the receipt; they are not passing performance comparisons.

The third integrated capture, `integrated-boundary-corrected`, passed with clean
shutdown, empty browser error/warning lists and 57–59 observed authoritative
shots per peer. Its 32,256,672-byte gzip trace contains 2,133,791 events, both
measurement marks and the measured-phase span. All three retained JavaScript
bundle hashes and byte counts match their manifest. Apple M3 Metal acceleration
was observed. The final portrait screenshot was inspected.

In this diagnostic capture, frame interval p95 was 16.7 ms, render submission
p95 was 2.9 ms, frame CPU p95 was 3.5 ms and input-to-render p95 was 16 ms.
Intervals above 25 ms were 0.055%. This remains a profiled desktop-hosted run;
it does not establish phone FPS or an optimization gain. Its corrected gameplay
workload and harness must be held fixed in subsequent unprofiled comparisons.

## Combined optimization capture

The later `current-wave-2` capture includes contour-query caching, snapshot
serialization reuse, asteroid collision caching/bounds and static validator
preparation. It passed with clean diagnostics and cleanup, 1,803 frame-interval
samples and 57–59 measured authoritative projectile witnesses per peer. The
30,395,536-byte gzip contains 1,945,508 events, complete measurement marks and
verified loaded-bundle hashes. Its portrait screenshot was inspected.

On the same M3 Metal, native DPR 3/full-glow, CPU-4 diagnostic configuration,
frame-interval p95 was 16.8 ms, frame CPU p95 was 2.9 ms, render submission p95
was 2.5 ms and input-to-render p95 was 15.9 ms. Intervals above 25 ms were 0.111%.
These profiled, independently evolving worlds do not form a causal A/B comparison.
The separate phase experiments establish each retained optimization's benefit.

An earlier attempt stopped before the build because a newly added reflection
regression invalidated the Wiki review digest. Its log remains retained. The
review was refreshed before this successful capture; no game data was collected
by the failed attempt.

## Next experiments

1. Use the new combined trace to select remaining measured costs. Actual phone
   setup is now the user's explicit [follow-up](../phone-testing-setup.md), with
   Samsung first and AWS as the fallback. No device result is implied here.
2. Run sustained GPU-backed sessions with matched controls, populations and
   unprofiled timing. Calibrate resolution/glow experiments within the same GPU
   cohort; do not mix the software and hardware captures into an A/B result.
3. Attribute any remaining native-paint cost before choosing geometry caches,
   worker rendering or a WebGL/library prototype. These captures do not justify a
   language rewrite of game arithmetic. The separate
   [backend kernel comparison](backend-language-results.md) now measures that
   question directly, with limits on full-server inference.
4. Continue the constrained transport experiment and validate on the target
   phone. Neither the M3 GPU nor CPU throttling establishes phone thermal,
   battery, raster or network behavior.
