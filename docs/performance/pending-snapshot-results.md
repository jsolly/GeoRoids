# Pending snapshots retain their accepted baseline

The broadcaster now skips an unsent offer to an open socket without forcing the next snapshot to be full. A successful in-flight callback establishes a valid baseline; a later delta can describe everything that changed while the socket was busy. Explicit resyncs, failed sends, closed sockets, periodic keyframes and byte-pressure recovery retain their existing behavior.

The change passed independent deterministic and live review and is integrated. The combined shipping gate remains pending. This is network-work reduction, not measured phone FPS. The separately identified benchmark-readiness repair is still in progress.

## Fixed-world proof

The test uses the actual broadcaster, encoder and decoder with controlled send callbacks and material world updates, additions, removals and order changes. Accepted sequences and reconstructed worlds are identical in both arms.

| Selected stalled recipient | Control | Candidate |
| --- | ---: | ---: |
| Accepted snapshots | 3 | 3 |
| Full snapshots | 2 | 1 |
| Deltas | 1 | 2 |
| Application bytes | 63,197 | 34,231 |

This selected sequence saves 28,966 bytes (45.8%). The post-stall full snapshot of 31,310 bytes becomes a 2,344-byte delta. Six pending offers cause no additional encoding or sending for the stalled recipient; the independent peer receives nine contiguous states in both arms. This is a delta-favorable sequence, not a projected percentage saving for every session.

Nine scenarios cover explicit resync while pending, synchronous and asynchronous send failure, closed-socket recovery, successful and failed callbacks from retired same-socket sessions, and the exact periodic boundary after 90 accepted deltas.

## Live 5 Mbps screen

One unchanged A/A pair and two reversed A/B pairs used 15 seconds of warmup and 30 seconds of measured combat. Each used one Chromium browser and four protocol peers, seed 42, native DPR 3/full rendering, a 390-by-844 touch viewport, CPU slowdown 4 and Apple M3 Metal. The proxy applied 5 Mbps down, 1 Mbps up, 40 ms latency and 20 ms jitter. Both arms used the current decoder and Path2D optimization, exact world coordinates and uncompressed WebSockets.

| Run | Arm | States/s | Full / delta snapshots | Average bytes/state | p95 gap ms |
| --- | --- | ---: | ---: | ---: | ---: |
| normal-aa-a | control | 20.66 | 109 / 511 | 29804 | 125.05 |
| normal-aa-b | control | 24.26 | 66 / 683 | 25345 | 120.93 |
| normal-ab-a | control | 23.76 | 65 / 737 | 25961 | 124.04 |
| normal-ab-b | candidate | 26.33 | 9 / 781 | 23411 | 119.35 |
| normal-ba-b | candidate | 27.56 | 10 / 817 | 22345 | 119.47 |
| normal-ba-a | control | 22.66 | 79 / 601 | 27179 | 124.25 |

The candidate's full-snapshot share falls to 1.14–1.21%, versus 8.10–17.58% in controls. It receives 26.33–27.56 states/s, above the control range of 20.66–24.26. Control A/A variation is substantial, and live world populations differ, so the exact improvement percentage is not isolated. Freed bandwidth delivers more states; total session bytes need not fall in proportion to the smaller messages.

All peers complete their scenario and explicit resync, acknowledge movement, offer shots, observe server projectiles and answer measured probes. All six runs finish cleanup. There are no raw errors, proxy failures, outbound failures, pressure skips or discarded simulation debt. Browser diagnostics are empty. Raw server logs retain 125 stale enhanced movement warning records across the six runs, with additional suppressed occurrences recorded; these are not warning-free sessions.

Recovery remains variable: candidate rejoins take 5.31 and 5.85 seconds, while controls range from 3.40 to 5.83 seconds. Application p95 is 1.0 ms in every run. Candidate mean frame CPU is within the A/A control range, and server broadcast p99 is 4 ms throughout. No reliable recovery or client-CPU improvement is claimed.

## Verification and artifacts

Both isolated arms passed focused units (17 control, 19 candidate), TypeScript, fresh Wiki source review and production builds. The source-swapping runner restored all three changed files byte-for-byte. Independent review recomputed every deterministic world and regenerated the live summary with an identical hash.

The first product unit command passed its 43 discovered tests but also found three scratch copies through Vitest's substring path filter; those copies failed import resolution. Unit scripts now restrict discovery to `tests/unit`. The focused product rerun and final combined verification are recorded in the receipt. No Wiki controls or behavior text changes are needed for this internal transport optimization.

See [the receipt](pending-snapshot-receipt.json) for source identities, per-run measurements, raw artifact hashes and retained limitations. Local full artifacts are under `.performance/pending-snapshot/` and the sibling `pending-snapshot-network/.performance/pending-network/network/` checkout.
