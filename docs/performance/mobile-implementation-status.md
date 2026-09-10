# Mobile performance implementation evidence

## Latest controlled comparison

The [contour timing comparison](contour-timing-results.md) completed three A/A
pairs and three A/B pairs. Frame smoothness was inconclusive: 0.88 percentage
points of median improvement versus 17.99 points of baseline variation. The
separate deterministic fixture proves 98.63% fewer contour endpoint reads.
The [isolated minimap comparison](minimap-work-results.md) proves six fewer
Canvas strokes and twelve fewer satellite/pickup position reads per frame.
Performance results are report-only, with no numeric-overrun CI warnings or
failures. Fixture recovery now checks live participants before resetting the world
and retries departures during baseline observation. The full repository gate and
missing/closed-transport integration cases passed. A 330-second combat run
exercised browser gameover and sixteen peer recoveries; subsequent review tightened
session-state checks. Final smoke verification covers the reviewed source.

## Browser optimization in progress

Repeatable constrained browser measurements are the primary optimization baseline.
Physical phones validate transfer to real hardware; missing Android hardware does
not block browser comparisons, general optimizations or regression budgets.
The browser sequence is recorded in the [runbook](mobile-measurement-runbook.md).

The first long exploratory portrait run used CPU 4, DPR 3, clean networking and
seeded combat, with 30 seconds of warmup and 330 seconds of measurement. It passed
correctness checks and retained 329.87 seconds of foreground gameplay, 16,272
frames, 999 input-latency observations, 544 input steps and 18 rejoins.
Frame intervals exceeded 25 ms in 21.08% of samples; p95 and p99 were 33.4 ms.
Frame CPU p95 was 2.8 ms, render submission p95 was 2.4 ms, and input-to-render
p95 was 4.2 ms. One sample does not establish variance or a performance gain.
Raw evidence is `.performance/mobile/aa-02-a.json` with source SHA-256
`03d1d76ae5c8904d3d27bcc2b61b0a64b1508ce8fe459b5c90d9eedd3ae68825`.

The preceding attempt failed CPU calibration before joining. Calibration now
uses warmed, repeated alternating control/throttled samples. Independent review
passed. The completed comparison validates source, fixture, release and environment
evidence across sessions.

## Outstanding acceptance

Physical acceptance has not run. The available phone is an iPhone 16e; its
OS/Safari version and recordings remain required. No Android phone is available.
Desktop Chromium cannot establish phone GPU, memory, battery or thermal behavior.
No reduced production graphics preset is accepted, and no phone performance
improvement is claimed.

The contour candidate has completed three A/A and three alternating A/B pairs.
Resolution and glow controls have short correctness runs only. Paired timing and
fifteen-minute instrumented/uninstrumented acceptance remain outstanding before
adopting a visual reduction. The minimap has an isolated work-count comparison;
a matched timing comparison remains necessary for any frame-rate claim.

## Implemented behavior

- The minimap renders local, human and bot pilots, retaining headings, faction
  marks and the arena ring. It no longer visits satellite or pickup managers.
- Diagnostic sessions can independently cap DPR at 2 or 1.5 and disable canvas
  glow. Default desktop and touch rendering stays native/full. Gameplay geometry,
  physics and the network world remain unchanged by these controls.
- Phone collection has explicit Start/Stop/Download, metadata inputs, bounded
  storage, interruption recovery and checksummed exports. Incomplete recordings
  remain visibly incomplete. Automated and phone collectors cannot compete for
  the recorder's drain.
- Client diagnostics retain phase durations, input timings, receive bytes/gaps,
  snapshot metadata and monotonic identified RTT probes. Server measurements
  provide identifiable finalized windows.
- The production benchmark supports CPU, DPR, network and seeded workload
  controls, real protocol peers, actual constraint witnesses and owned cleanup.
  Session comparisons ingest raw artifacts and retain their checksums.

The [decision ledger](mobile-quality-decisions.md) records each candidate's visual
tradeoff and removal comparison. The minimap simplification is a permanent product
choice, separate from temporary graphics reductions.

## Verification receipts

Local artifacts are under `.performance/mobile/` (gitignored). These working-tree
runs are diagnostic evidence, not release measurements.

| Check | Result |
| --- | --- |
| Original revision b4aec298, portrait, 30 s warmup + 300 s | Passed legacy harness; 15,891 retained frames, 10 rejoins, only 10 input timing samples. DPR 1; unsuitable as a phone or causal candidate baseline |
| Initial new control, combat, DPR 3, CPU 1, clean, 5 s + 15 s | Passed initial harness; 904 frames, 435 authoritative motion advances, 32 shots. Later review strengthened completion checks |
| Initial combined CPU 4/degraded smoke | Failed unanswered peer RTT and bounded close waits; retained report. Found per-chunk proxy latency accumulating artificial queueing |
| Corrected 1 Mbps combined stress | Failed useful delivery budget: 76 snapshots / 15.37 s, average 21,354 bytes per snapshot, about 109 KB/s total receive traffic against 125 KB/s capacity. Ideal capacity at that payload is 5.85 snapshots/s; observed 4.94 Hz. Excluded from graphics comparisons |
| Full repository gate | Passed lint, unused-code checks, docs, runner contracts, both TypeScript checks, full unit suite and production build |
| Rendering/HUD focused unit checks | 12 passed |
| Collector browser checks | 4 passed, including reload recovery, download checksum and duration limit |
| Touch/HUD browser checks | Passed simultaneous controls, ability/shield, cancellation, orientation and safe-area layout |
| CPU 4 lifecycle and detector browser scenario | Passed orientation release, actual page freeze/resume, actual socket reconnect, injected render and input-handler work detection |
| Wiki | Desktop/mobile navigation, search, media controls and routes passed; pickup media regenerated and reproducibility verified, images inspected |

The required CI combined traversal lane uses the normal 5 Mbps profile, with a
separate clean-network combat lane. This
is an explicit adjustment from the proposed 1 Mbps lane: the 1 Mbps combat case
currently saturates its link and remains a failing diagnostic, not a passing
regression baseline. These early impaired artifacts were superseded when the proxy was further corrected
to separate propagation from transmission under sustained backpressure. Their
observed payload sizes identify a capacity concern; use the final matrix for
network attribution.
Payload/rate investigation remains required before claiming support for that
network workload. The final short matrix is recorded below. The full repository gate passed, including unit tests and the production build. No changes have been pushed or deployed.

### Historical short matrix

All 22 planned viewport/constraint scenarios ran with a 5-second warmup and
15-second measurement: 11 passed the then-current checks and 11 failed.
This matrix predates report-only numerical thresholds. Its state-gap and delivery
overruns are observations under the current policy; cleanup failures remain errors. Passing these
checks does not imply sustained 60 fps.

| Lane | Desktop | Portrait | Landscape |
| --- | --- | --- | --- |
| CPU 1, clean, combat | Passed | Passed | Passed |
| CPU 4, clean, combat | Failed: 433.1 ms state gap | Passed | Passed |
| CPU 4, normal 5 Mbps, traversal | Failed: 342.3 ms state gap | Passed | Passed |
| CPU 1, degraded 1 Mbps, combat | Failed delivery | Failed delivery | Failed delivery |
| CPU 4, degraded 1 Mbps, combat | Failed delivery | Failed delivery | Failed delivery |
| CPU 6, degraded 1 Mbps, combat | Failed delivery | Failed delivery | Failed delivery |

Four additional portrait controls passed: device DPR 1, DPR cap 2, DPR cap 1.5,
and glow off. They are single short runs, not evidence for adopting a candidate.

All nine degraded cases also exceeded peer-close deadlines. Each verified that
no human participants remained on the authoritative server. The harness retained
cleanup failures and stopped subsequent cases; the missing touch cases were then
run in separate owned sessions. Runner cleanup completed after each command.
These reports are excluded from candidate comparisons.

During verification, fixture reset omitted fuel retained from pickups, and abrupt
browser closure could leave a resumable participant between viewports. Both
harness defects were fixed. Fixture manifests and authoritative departure checks
now expose these failures; earlier affected reports remain preserved.

The final matrix artifacts use `.performance/mobile/verified-*.json`; the
`verified-matrix-receipt.json` file records each raw report SHA-256, outcome and
final source/build hashes. All final runs used source hash
`e282e7e01c8870a28f204a06735ba9a7ec4f2e6d4055274000d76ef9366c26e0`.
The earlier CPU 4 desktop run recorded frame-interval p95 of 83.3 ms while
frame CPU p95 was 3.8 ms (render submission 3.1 ms). This does not isolate a GPU
cause: JavaScript submission time alone does not explain presentation delay.
Inspect real-device timelines before choosing a rendering optimization.

## Attribution rules

A short smoke proves constraints and correctness checks execute. It does not
establish stable frame percentiles or an improvement beyond noise. Compare the
same source/harness and workload with one quality setting changed; keep whole
session phase accounting and failed reports. Do not pool phone cohorts.

Contour indexing now has matched deterministic evidence and inconclusive timing
evidence. DOM HUD cadence, worker decoding, network payload changes and server
optimizations remain investigation candidates in the
[measurement runbook](mobile-measurement-runbook.md). Browser measurements can
investigate them without waiting for physical phones.

## Recurring review

The [Grokbot prompt](monthly-review-prompt.md) requests a monthly review of retained
benchmark results and reference values. No local scheduled automation has been
created. Numerical changes produce reports only; they do not warn or fail CI.
Reference values may move up or down after an explicit tradeoff review.
