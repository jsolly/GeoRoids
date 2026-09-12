# Current-source WebSocket compression, September 12, 2026

Both tested settings are rejected under the fixed clean-network CPU limit.
Production keeps uncompressed JSON snapshots at 30 Hz and simulation at 60 Hz.
Compression saves substantial bandwidth, but neither candidate meets this
experiment's acceptance conditions. This is not a phone FPS result or a claim
that every compression configuration is unsuitable.

## Measured tradeoff

The valid comparisons below include actual gameplay WebSocket transport bytes
and total server process CPU, including zlib workers. CPU is expressed as a
fraction of one core over finalized measurement windows.

| Setting / valid clean pair | Download reduction | Server CPU, control → candidate | Relative CPU increase | A/A CPU variation | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Level 6 / A/B | 65.72% | 8.51% → 13.14% | 54.45% | 1.22% | Fails 10% CPU limit |
| Level 1 / B/A | 66.10% | 9.00% → 11.11% | 23.39% | 5.20% | Fails 10% CPU limit |

Level 1 was the single-parameter follow-up to level 6's measured CPU overhead.
All other settings, current P4 precision, pending-send handling, decoder,
gameplay and limits stayed fixed. Both valid pairs delivered roughly 30 states
per second. These dynamic worlds differ in live outcomes; the byte reductions
are observed paired results, not exact same-world structural counts.

The limit was fixed before results: each matched CPU increase must stay below
the larger of 10% or the lane's A/A variation. The lower-level result does not
pass that limit merely because its absolute CPU increase is about two core
percentage points. No adoption threshold was changed after observing results.

## Completion and failed evidence

Each batch uses one A/A pair and alternating A/B and B/A pairs, with 15 seconds
warmup and 60 seconds measurement. The three batches contain 18 game runs:
15 process exits succeeded and three failed. A zero exit is not an adoption
pass. Full per-run checks remain in the [receipt](current-compression-receipt.json).

- The level-6 clean batch has one incomplete rejoin at the measurement endpoint.
  Its valid pair also fails the calibrated recovery comparison.
- The level-6 5 Mbps batch has incomplete A/A calibration. Two controls end with
  unfinished requested rejoins. The completed candidates separately fail the
  fixed recovery or maximum-gap checks. No paired speed claim follows.
- All six level-1 clean processes finish. One candidate has a pending callback
  at the sampled boundary and fails that gate; the other forms the valid B/A
  comparison above. This does not demonstrate sustained queue growth.
- Six earlier attempts failed the production Wiki review before gameplay
  sampling. Their logs remain. Explicit review repaired the experiment's
  metadata; product/runtime sources did not change for that repair.

Rejoin timing includes actual request-to-prepared-world driver, IPC and polling
work. It excludes intentional browser menu time and preserves incomplete
requests. An endpoint-censored request is incomplete evidence, not proof that a
player could never reconnect. All original gaps and exclusion intervals remain.

## Scope and verification

The accelerated Chromium workload uses an Apple M3, touch portrait at 390×844,
DPR 3, CPU slowdown 4, native/full graphics, seed 42, one browser and four peers.
The proxy schedules each TCP connection independently; gameplay and log sockets
do not share one physical-phone link. The receipt separates both routes and
records measured up/down bytes. Browser timings occur after native inflation
and cannot establish whole-browser CPU savings.

The candidate uses the existing shared WebSocket server, retaining server
compression context, disabling client context, window 15, memory level 5,
concurrency 4 and threshold 1024. The pinned `ws` implementation can compress
small server messages when context is retained, so this includes ordinary
server events and logger negotiation, not snapshots alone. See the
[ws compression documentation](https://github.com/websockets/ws#websocket-compression).

Both configurations pass the real-socket correctness matrix: 12 cases in four
files per arm, including offered/declined extensions, ordering, malformed/resync
handling, interrupted sends, rejoin, reconnect and owned-process cleanup.

The 1 Mbps screen and matched 5/25-pilot ten-minute compression soaks were not
run: both settings had already failed the mandatory clean CPU gate and neither
is proposed for adoption. No sustained-memory, supported-capacity or Linux/
Railway conclusion is claimed. The retained harness permits those tests for a
new candidate with a concrete reason to outperform these settings.

The separate [current-P4 MessagePack screen](current-binary-codec-results.md)
finds a raw-byte lead but independently fails its predeclared CPU limit.
Neither failed configuration proceeds to browser/transport adoption tests. Physical-device setup remains the requested
[documented follow-up](../phone-testing-setup.md).
