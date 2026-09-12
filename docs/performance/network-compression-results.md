# Snapshot compression investigation, September 12, 2026

The [current-source comparison](current-compression-results.md) supersedes this
exploratory configuration. Both tested compression levels fail its fixed clean
CPU limit; production transport remains uncompressed. Historical results below
retain their original workload and limitations.

## Open goal and current decision

Performance alternatives are not exhausted. Compression remains an isolated
experiment; production still uses uncompressed snapshot v1. Renderer libraries,
WebGL, workers, binary protocols, runtime/language changes and the client-server
loop remain open where current measurements justify an experiment.

The first candidate uses the existing `ws` implementation of permessage-deflate with
level 1, memLevel 5, a 12-bit server window, no context takeover, concurrency 4,
and a 1,024-byte threshold. It changes no snapshot fields, broadcast cadence,
simulation, damage, projectile range, rendered quality or client controls.
These are experiment settings, not established production limits. The
[ws documentation](https://github.com/websockets/ws#websocket-compression)
describes the extension and its CPU/memory tradeoffs. Linux concurrency and
long-session memory still need measurement.

Both arms contain the 25% pace and path-reuse changes from the
[previous pass](mobile-pace-results.md). The baseline is
`codex/mobile-performance-and-pace` at `771acd9` plus those working-tree changes.
The isolated candidate is at
`/Users/johnsolly/code/GeoRoids-worktrees/network-compression-experiment`.
Newer gameplay changes are outside this frozen experiment. The implementation
has since integrated `origin/main` at `5d27a1a`, preserving the new abilities and
CMS manual. This older experiment remains historical; current acceptance needs
matched recordings from the integrated workload and corrected GPU harness.

## What the current runs show

All runs use the production client, Chromium 153.0.8010.12 on an Apple M3,
390×844 CSS pixels, device DPR 3, CPU slowdown 4, native resolution/full glow,
and seeded combat with one browser and four protocol peers. Proxy bandwidth is
per connection. Software Canvas and SwiftShader are not a physical phone GPU.

The first 1 Mbps baseline failed browser recovery before the measured phase.
A candidate with one compressed browser and four uncompressed peers failed peer
recovery. After peers offered compression, the all-compressed 1 Mbps candidate
also failed peer recovery before measurement. Its browser handshake and all four
peer extension strings confirm compression was negotiated. None of these failed
recordings is a passing comparison or evidence that 1 Mbps combat is solved.
Their graceful peer-close deadlines also failed; the runner subsequently stopped
its owned processes. Those failures remain in the raw reports.

The first 5 Mbps pair exposed a driver race described below. The next pair used
the corrected driver and passed its workload, snapshot, motion, projectile and
cleanup checks with empty browser error/warning lists. Each requested 30 seconds
of warmup and 90 seconds of measurement.

| Observation | Uncompressed | Compressed |
| --- | ---: | ---: |
| Measured browser state delivery | 27.87 Hz | 29.79 Hz |
| Snapshot arrival gap p95 | 117.4 ms | 60.9 ms |
| Snapshot arrival gap p99 | 140.2 ms | 78.2 ms |
| Largest snapshot arrival gap, including recovery | 4,176.8 ms | 125.9 ms |
| Peer recovery durations | 2,048–4,008 ms | 183–249 ms |
| Total observed proxy download bytes | 370,635,101 | 111,023,736 |
| Client render submission p95 | 2.4 ms | 2.7 ms |
| Client frame CPU p95 | 2.9 ms | 3.2 ms |
| Input handler-to-render p95 | 3.7 ms | 4.0 ms |
| Frame intervals above 25 ms | 46.49% | 51.22% |

The roughly 70% lower proxy byte total includes warmup, measured gameplay,
events, logs and probes. It is not a snapshot-only compression ratio. The worlds
evolve differently despite the same initial fixture, so population and offered
input evidence must be reviewed before attributing performance differences.
This single short pair is exploratory, without A/A noise calibration. It shows
a promising congestion/recovery result, not a rendering improvement or an
accepted production configuration.

Finalized server windows in this pair recorded broadcast p99 bucket bounds no
higher than 4 ms. Tick p99 bounds were at most 2 ms for the baseline and 4 ms for
the candidate. Recorded RSS reached approximately 224 MB and 230 MB respectively.
Those are short macOS observations, not a leak test or Linux capacity result.
The `broadcastSamples` counter includes event fanouts as well as world snapshots;
43–45 metric samples per second does not imply a higher snapshot cadence.

The [artifact receipt](network-compression-exploration-receipt.json) retains the
recordings, their statuses, raw paths, SHA-256 hashes, source/harness provenance,
and scoped observations. Failed normal runs remain excluded from the table.

## Corrected 1 Mbps follow-up

A new pair used the corrected driver and retained browser negotiation witnesses.
Both the uncompressed baseline and the 12-bit-window candidate still failed peer
recovery. The baseline reached 35 measured browser states; the candidate failed
before measurement. All four graceful peer closes timed out in each run, and the
runner then stopped its owned processes. These failures establish that the
first-state driver race was not the only problem at this bandwidth.

The next candidate changed only the server window from 12 to 15 bits, retaining
level 1 and disabled context takeover. It reached 775 measured browser states
before another peer recovery timeout. A completed earlier peer recovery already
took 13.7 seconds. It is also a failed recording, not a passing comparison.

The following experiment retains the 15-bit window and enables server context
takeover, keeping client context takeover disabled. This preserves compression
history between messages. In the pinned `ws` sender, the threshold only applies
when context takeover is disabled, so this setting also permits compression of
small server messages. That is part of the candidate definition and its cost
must be measured. Each variant's negotiated extension string and source hash
remain in its raw report.

The retained-history level-1 candidate still failed peer recovery after 338
measured browser states. Increasing only compression level to 6 completed the
90-second measured run with clean shutdown, no browser errors or warnings, and
confirmed negotiation on the browser and all four peers. Browser delivery
averaged 30.32 states per second, but arrival gaps reached 536.5 ms and protocol
peer ping round trips were 2.12–2.18 seconds. Each peer supplied one ping sample;
these four samples are not a latency distribution. Four peer recovery episodes took
3.37–5.48 seconds. Completing that short run does not mean latency is acceptable;
the remaining backlog warrants reducing offered bytes or pacing snapshots.

A subsequent isolated trial lowers only periodic snapshot cadence to 20 Hz while
keeping the authoritative simulation at 60 Hz. Its initial build stopped at the
Wiki source-review check. Review confirmed that the manual describes 60 Hz
simulation and does not promise a snapshot cadence; no copy or demonstrations
need to change for this experiment. That build failure is retained separately.
The cadence experiment completed 90 measured seconds with clean shutdown and no
browser errors or warnings. Its browser state rate was 18.81 Hz, including a
browser game-over recovery. Arrival gap p95 was 111.7 ms and p99 was 150.9 ms.
Four peer ping samples were 144–258 ms. Peer recoveries took 387–526 ms. The
browser game-over recovery took 4.03 seconds, and the largest state gap was
4.80 seconds. The proxy observed 55.27 MB down, versus 75.29 MB in the 30 Hz
level-6 run, with warmup, all traffic and differing live game outcomes included.

Rendering did not improve in this comparison. Frames above 25 ms were 28.80%
in the 30 Hz run and 50.61% in the 20 Hz run. Render submission p95 was 2.2 ms
and 2.7 ms; frame CPU p95 was 2.7 ms and 3.2 ms. The live worlds and recoveries
differed, so these observations cannot isolate a cadence effect. Both runs kept
broadcast and transport-acceptance p99 bucket bounds at or below 4 ms; tick p99
bounds were 2 ms and 4 ms. Recorded server RSS maxima were about 239 MiB and
238 MiB. These short macOS windows do not establish Linux capacity or memory
stability.

These are promising congestion observations from a single short trial. The
candidate still needs sustained repeat sessions, offered-input and population
comparison, server cost checks, remote-motion/shot feedback checks and physical
phone acceptance. No compression or cadence change has entered the implementation
branch's product code.

## Motion cost of a lower snapshot rate

A source audit after integrating `5d27a1a` found that remote human and bot hulls
hold their latest snapshot pose. `advanceRemotePlayerShips` advances lifecycle
effects and lasers, and `Ship.updateMovement` skips bot movement. A 20 Hz stream
therefore holds those hull poses for roughly three 60 Hz frames instead of two.
The current client has no interpolation buffer to hide that change.

Asteroids and projectiles advance locally between snapshots, with different
correction rules. Asteroid positions snap only after drift exceeds 12 units;
their rotations come directly from snapshots. Authoritative player and satellite
projectiles reset to snapshot positions, so longer gaps allow larger corrections.
Satellite shot notifications also wait for the next periodic broadcast.

Before adopting lower cadence, compare per-frame remote displacement and pose
hold time, correction distance/count, projectile birth/removal delay, and visible
heading/thrust changes. Include impulses, splits and recovery. Existing local
input and delivery diagnostics do not establish these remote-motion outcomes.
Interpolation or bounded extrapolation is a separate candidate to measure.

## Driver and evidence fixes

The benchmark previously treated a join acknowledgment as proof that its first
world snapshot had arrived. Under delayed delivery, its input timer ran between
the two messages and raised `Pilot has no authoritative entity`. It now waits
for both, retaining the original ten-second join deadline. Once a state exists,
missing actors and invalid sequence/decoder state still fail the run. Old-world
frames queued before a same-socket rejoin acknowledgment are still ignored.

A real WebSocket regression scenario separates acknowledgment and keyframe,
verifies no movement is sent in between, checks the deadline with a controlled
clock, then verifies exact snapshot reconstruction and resumed input. It passes
with compression enabled and disabled. Restoring the old condition makes both
variants fail on the original missing-entity error.

Protocol peers now offer compression like browsers and report negotiated
extensions. The load report derives its compression flag from those actual
connections. The browser recorder retains only gameplay URL, HTTP status and
the negotiated extension string, never other handshake headers. Chromium runs
require a successful upgrade witness; WebKit explicitly reports that this CDP
observer is unavailable.

Independent review caught that successful reports rebuilt their constraints
object and discarded the new browser handshake witness. The recorder now
preserves it on success as well as failure. The passing short pair above predates
that last reporting fix, so its peer witnesses are retained but its successful
browser handshake is absent. Subsequent acceptance runs must use the corrected
recorder. This limitation does not get repaired retroactively in old artifacts.

The full repository gate passed after these fixes, including lint, unused-code
checks, compiler checks, all unit tests and the production build. The earlier
receipt-format failure was corrected and the complete gate rerun.

## Remaining experiments

1. Repeat the corrected normal-network comparison with calibration and sustained
   workloads, including negotiation, delivery, recovery, actual offered inputs,
   visible populations, server CPU/GC and memory. Validate clean-network overhead
   and loaded concurrency before adopting compression.
2. Revisit 1 Mbps combat. If lossless compression cannot keep delivery current,
   compare representative binary/schema encodings and bounded application-level
   in-flight snapshots. Preserve the complete state and baseline recovery chain.
3. Attribute native-resolution rendering and allocation costs separately.
   Investigate harpoon field reconstruction, contour candidate allocation,
   text measurement, raster cost, and then equivalent-scene worker/WebGL
   prototypes where warranted. Existing code inspection does not reject those
   alternatives or establish a benefit for a language rewrite.
4. Complete current-source integration, physical-device and deployed-load
   acceptance before claiming the requested performance ceiling. No changes from
   this task have been pushed or deployed.
