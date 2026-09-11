# Benchmark framework

The benchmark command measures a pinned product revision with one committed copy
of the benchmark harness. It produces raw artifacts for review. It does not make
an optimization claim, a frame-rate guarantee, or a supported-capacity claim.

## Run a measurement

Run these commands from `/Users/johnsolly/code/GeoRoids` (or a clean linked
GeoRoids worktree). `REV` may be a commit, tag, or other
Git revision that resolves to a commit.

```sh
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport desktop
npm run benchmark -- measure server --revision HEAD --seed 42
npm run benchmark -- measure codec --revision HEAD --seed 42
npm run benchmark -- measure transport --revision HEAD --seed 42
```

The client viewport can be `desktop`, `touch-portrait`, or `touch-landscape`.
The other runners use `desktop`. The seed defaults to `42`.

Compare two revisions with the same workload:

```sh
npm run benchmark -- compare client --baseline REV --candidate REV --seed 42 --viewport desktop
npm run benchmark -- compare server --baseline REV --candidate REV --seed 42
npm run benchmark -- compare codec --baseline REV --candidate REV --seed 42
```

Comparison is available for client, server, and codec. Transport is a realtime,
nondeterministic sample and accepts one revision only.

## Preconditions and isolation

The harness checkout must be clean and committed. The runner resolves and records
the harness `HEAD` before it starts. It archives each requested product revision,
removes that revision's `benchmarks` directory, and overlays the same harness
archive onto every runtime, including the shared
`tests/unit/network/snapshotFixture.ts` generator. This keeps product code variable
while benchmark code and the codec input generator stay fixed.

The runner checks the installed dependency graph against `package-lock.json`. When
the lock matches, it links the verified installed `node_modules`; otherwise it
runs `npm ci` inside the archived runtime. It records the lock hash and dependency
hash. Source hashes are checked across setup and measurement; dependency hashes are
checked across measurement. A changed input fails the run.

Each invocation gets a new directory under `/tmp/georoids-benchmarks/run-*`.
Keep that directory when reviewing a result. It contains the invocation and
environment, archived runtime setup, before/after hashes, command stdout/stderr,
measurement data, and a completion or failure report. Owned child process groups,
browser contexts, sockets, and servers are closed before a result can be complete.

## What each runner measures

| Runner | Workload and primary observation |
| --- | --- |
| `client` | A compiled diagnostic scene in Chromium at the selected viewport. Timing and observation use fresh contexts. |
| `server` | Direct `GameEngine` ticks with two real loopback human peers and two seeded engine-created bots. |
| `codec` | Seeded snapshot fixtures across shared and staggered recipient baselines, with 1, 2, 5, 10, and 25 recipients. |
| `transport` | Two real loopback clients against an owned child server for the default two-second window. |

The client timing context uses native `requestAnimationFrame` timestamps and
`performance.now()`. `updateMs` and `renderMs` are synchronous CPU submission
times. `frameIntervalMs` is a separate scheduling observation. None of these
values proves that a GPU presented a frame. A second fresh observation context
counts actual `CanvasRenderingContext2D` and `Path2D` API calls, including HUD and
environment probes. Those counts describe submitted API work, not GPU draws, and
are kept outside the timed result.

The server runner fixes `Date.now()` and seeds `Math.random()` while retaining
native `performance.now()` for tick timing. It creates two actual loopback human
connections and two bots through the seeded engine. Natural authoritative
simulation continues during warmup and measurement, so asteroid, loot, satellite,
and pickup counts before and after are part of the result.

The codec runner checks every decoded message against the original fixture state,
including keyframes, deltas, and divergent recipient baselines. Its byte counts
use UTF-8 application payloads from the JSON snapshot envelope. They do not count
WebSocket transport framing. Encode/serialize and decode timings are separate.

The transport runner measures realtime ping RTT and snapshot delivery intervals,
packet and UTF-8 payload counts, client `bufferedAmount`, and child-server event
loop delay. Native scheduling remains nondeterministic. The sample's seed chooses
client IDs and requested poses; the server seed is owned by the server factory.

## Comparisons and interpretation

A comparison first runs three baseline A/A calibration pairs, then twelve paired
A/B samples. Pair order alternates so the candidate does not always run second.
Every result must have matching parameters, outcome witness, and primary metric.
Exact work counts must repeat within each revision and the A/A calibration.
Baseline and candidate counts may differ: fewer Canvas calls or payload bytes
are useful comparison results. A changed game outcome, missing participant, or
nonrepeatable count rejects the comparison even when measured time is lower.

The report includes a fixed-seed paired descriptive interval and a calibration
stability flag. The interval describes these samples and their machine scheduling;
it is not a confidence claim, capacity limit, or generic "performance win" label.
Read `work.baseline` and `work.candidate` separately from timing. A verdict of
`inconclusive` means the samples do not support a timing direction; calibration
drift is reported separately.

The shared result shape is implemented in [`results.ts`](results.ts). Runner
entry points are [`run.ts`](run.ts), [`sample.ts`](sample.ts),
[`client.ts`](client.ts), [`server.ts`](server.ts), [`codec.ts`](codec.ts), and
[`transport.ts`](transport.ts). The transport child is
[`transport-server.ts`](transport-server.ts); the compiled browser fixture starts
at [`client-entry.ts`](client-entry.ts).

Use the historical files under `docs/performance/` only as archived evidence from
their recorded revision. They are not current benchmark output and do not define
supported devices, loads, or production behavior.

## Realtime production client and load sessions

Run from `/Users/johnsolly/code/GeoRoids` or the absolute path of the implementation
worktree. These commands acquire the repository integration lock, build the
production client, start an owned preview/server pair, and clean up that pair:

```sh
npm run benchmark:realtime -- --viewport all --warmup 30 --seconds 180 --output .performance/client.json
npm run benchmark:load -- --pilots 5 --warmup 30 --seconds 180 --output .performance/load.json
npm run benchmark:load -- --pilots 5 --network degraded --warmup 30 --seconds 180 --output .performance/load-degraded.json
```

Use `GEOROIDS_TEST_VITE_PORT` and `GEOROIDS_TEST_SERVER_PORT` to select free ports.
The runner refuses occupied ports. The default deadline is 1200 seconds; a
30-minute soak needs a larger `GEOROIDS_TEST_MAX_DURATION_SECONDS` value that also
allows admission, warmup, build and cleanup. Timed sessions must run separately
from tests, coverage, builds and other measurements.

These runs measure the current worktree and real scheduling. They do not use the
archived paired-comparison machinery above. Dirty results are diagnostics, never
release evidence. Git inspection and lockfile hashing must succeed before a
session starts; Git commands have a ten-second deadline. Missing provenance
fails the command instead of producing a report with an unknown revision or lock
hash. Reports retain source/build hashes and fail if either changes during the
session. The client uses the shipped entry point and real input; its
`performance=collect` query enables the separate diagnostics recorder. Viewports
are desktop, touch portrait and touch landscape. Chromium touch uses simultaneous
trusted playfield steering/fire events. WebKit is available with `--browser webkit`, but
desktop WebKit with touch emulation is not an iPhone measurement.

The load driver uses the real protocol and decoder, realistic input/shoot
messages, phased admissions, pings and resync requests. Every pilot uses the
current snapshot protocol. Free/handoff motion uses epoch-tagged
poses; constrained motion uses input messages. Measured authoritative
acknowledgment advancement for commands sent during measurement is required, so
warmup acknowledgments and rejected commands cannot pass as useful load. Each
negotiated session must deliver contiguous sequences. The diagnostic delivery
checks record delivery below 27 states/second, with a two-state allowance for window
endpoints, across the complete measured window,
including rejoins, or above a 250 ms gap. These are reporting thresholds, not
calibrated capacity limits. Every offered pilot must finish joined with measured
authoritative state; slow delivery is recorded without failing the run.
Raw delivery intervals and unanswered measured pings remain in the report; an
unanswered measured probe fails the run. Shot rates are offered commands. Each
negotiated pilot must also observe an authoritative projectile born after its
first measured movement acknowledgment. Game-over pilots leave and rejoin on their existing socket; `gameJoins`
records this session churn separately from TCP connections. It measures generator CPU, memory and event-loop
delay alongside server health and client delivery. A shared-host run does not
establish Railway capacity or prove an independent load generator has headroom.

`benchmarks/tcp-proxy.ts` provides a bounded, ordered TCP impairment building block.
The load driver's `--network normal` and `--network degraded` modes use it against
the owned local server's WebSocket path. HTTP health probes bypass the proxy to
observe the server directly; they do not measure impaired-path availability or
latency. Client RTT replies and state-delivery gaps validate that path. Limits
apply to each connection, not shared aggregate
cellular bandwidth. It delays and throttles chunks without dropping arbitrary protocol deltas. Its
configured propagation/jitter model is an approximation; report measured RTT and delivery
intervals rather than treating settings as observed network latency.

Isolated architecture experiments are `collision-experiment.ts` and
`protocol-experiment.ts`; decisions and limits are in
[`docs/performance/implementation-status.md`](../docs/performance/implementation-status.md).

### Mobile constraints and repeatable fixtures

Run from `/Users/johnsolly/code/GeoRoids`. Use the same command with
`--network clean`/`degraded` and `--cpu-slowdown 1`/`4` for the four control,
CPU, network, and combined lanes. Use `touch-landscape` for 844×390; portrait
is 390×844. DPR 1 and CPU slowdown 6 are additional diagnostic comparisons.

```sh
./scripts/test-runner.sh --benchmark-client --viewport touch-portrait --dpr 3 \
  --cpu-slowdown 4 --network degraded --seed 42 --scenario combat \
  --warmup 30 --seconds 300 --render-dpr native --render-glow full \
  --output .performance/mobile-combined.json
```

Defaults remain DPR 1, CPU slowdown 1, clean network, seed 42, and traversal.
CPU throttling is Chromium-only. Simultaneous touch automation is also
Chromium-only; WebKit runs require `--viewport desktop`. Neither is physical
phone acceptance. Diagnostic graphics comparisons accept `--render-dpr native`,
`2`, or `1.5`, and `--render-glow full` or `off`.

The runner starts an owned impairment proxy before building the production
client and bakes its ready port into the WebSocket endpoint. Calibration records
unthrottled/throttled browser CPU work and matched direct/proxied HTTP health
response durations and byte counts. These HTTP response probes witness delay and
observed transfer throughput; they do not establish bandwidth saturation or a
phone-equivalent CPU. Gameplay endpoint events and proxy traffic independently
witness routing. Periodic server health bypasses the proxy. Proxy limits are per
connection, not aggregate cellular bandwidth. Runner status and final proxy
statistics survive in `.performance/runner-*`, including build failures.

Traversal prepares one human with the current ambient populations. Combat
prepares five human pilots (one browser plus four real-protocol peers), two
observed bots, 80 asteroids, six satellites, and two pickups. A private Unix
socket in the runner's temporary session directory validates the complete
participant set before synchronous between-tick arrangement. It preserves human
motion sessions, advances placement epochs through the existing authoritative
placement path, and requests a fresh snapshot baseline per recipient. Every
participant must observe that baseline before warmup. Game rejoins repeat setup.
The protocol peers share the load runner's `Pilot` implementation.

Each fixture reports the seed, full initial world manifest, hash, epoch, actual
participant IDs and expected snapshot sequences. Random entity IDs are excluded
from the repeatability hash. Combat starts in a compact player formation with
four nearby hazards. Per-interval total populations and visible entity centers
record how the workload evolves; positions outside the view, explosions, deaths,
and respawns mean initial counts alone cannot establish comparable rendering
work. Runtime gameplay remains live and is not deterministic replay.

The browser alternates trusted steering/fire presses on anchored one-second slots and attempts
available ability/shield controls. Reports require authoritative movement and
new projectile witnesses. A five-minute run additionally requires at least 300
input steps. Skipped slots are accepted only when their scheduled instant falls
inside a recorded browser game-over recovery of at most ten seconds. Peer setup
and unexplained active-play stalls do not qualify. Recovery duration and skipped
slot counts remain in comparison evidence; at least 300 measured actions and
slots are still required. Raw `inputToRenderMs` samples, rather than the offered step count,
are the acceptance denominator. Finalized server windows are deduplicated by
window ID; overlapping open health windows remain raw evidence only.

### Comparing mobile sessions

`benchmarks/mobile-comparison.ts` compares session summaries without pooling
frames. The CLI derives summaries directly from raw report paths. Its manifest
contains `cohort` (exact device/browser/OS/settings), `scenario` (`traversal` or
`combat`), and `aa`/`ab` arrays, each containing at least three `[baselinePath,
comparisonPath]` pairs. Paths are relative to the manifest. Record one viewport
per automated report. Every path must identify a distinct session.

The controlled browser CLI rejects phone exports: they remain useful physical
validation evidence, but lack the automated source, harness and fixture witnesses
required here. It rejects failed/incomplete sessions, profiling runs, omitted raw
samples, source drift and mismatched environments. Every report must include the
new product/harness provenance partitions; older exploratory reports cannot be
silently promoted. Output retains source paths, SHA-256 hashes, release identity,
raw population and input-cadence evidence, and derived summaries.

```sh
# Working directory: /Users/johnsolly/code/GeoRoids
npx --no-install tsx scripts/compare-mobile-sessions.ts \
  --manifest .performance/session-pairs.json --output .performance/comparison.json
```

The manifest requires an explicit `experiment` object:

```json
{
  "kind": "quality",
  "harnessSha256": "<64 hex characters from report metadata.git>",
  "lockfileSha256": "<64 hex characters from report metadata.git>",
  "fixtureHash": "<64 hex characters from the prepared fixture>",
  "baseline": {
    "sourceSha256": "<baseline source hash>",
    "productSha256": "<baseline product hash>",
    "quality": { "maxDpr": "native", "glow": "full" }
  },
  "candidate": {
    "sourceSha256": "<candidate source hash>",
    "productSha256": "<candidate product hash>",
    "quality": { "maxDpr": 2, "glow": "full" }
  }
}
```

A `quality` experiment requires identical source/product hashes and exactly one
quality setting changed. A `product` experiment requires different product/source
hashes and identical graphics settings. A/A uses the baseline arm throughout;
A/B uses the declared arms. Harness, dependencies, environment (including the
observed GPU path), viewport, device DPR, CPU, network, seed and fixture identity
remain fixed. Release identity must be stable within each source arm. Product
hashes cover client/server/shared/setup/public assets and root product entries;
the harness partition covers benchmark/runner code, test fixtures, compiler/build
configuration and package manifests. Together they cover all recorded source
inputs. Built output hashes must remain unchanged within each session.

`relativeResult` reports improvement only when the median paired reduction in
frames over 25 ms exceeds the largest A/A absolute difference and frame p99, CPU
p95 and input p95 regressions remain within A/A variation. `absoluteTargetsMet`
separately reports whether all candidates meet the fixed frame, CPU and input
budgets. A relative improvement does not imply those targets or physical-phone
acceptance were reached. `workloadReviewRequired` remains true: reviewers must
inspect total/visible population distributions, actual offered input cadence,
rejoins, authoritative motion/shots and phase ledgers. Identical initial fixtures
do not prove identical evolving gameplay or offered inputs.

At least 95% of wall time must be foreground play/respawn, with at least 300
foreground seconds and 300 completed measured input actions. Frame timing
coverage, frame CPU counts and input latency sample counts must agree. Lifecycle
and fifteen-minute thermal validation remain separate.

For a separate attribution run, add `--cpu-profile .performance/game.cpuprofile`
to the production-client command with Chromium and a single viewport. Profiling
runs only around the measured phase and preserves a partial profile on failure.
`profileRecorded` disqualifies the report from timing comparison. Reports also
capture Chromium GPU devices, renderer and feature status; unsupported WebKit
GPU inspection is explicit. Neither browser emulation nor a software renderer
establishes the behavior of a phone GPU.

Real-time performance budgets allow two states for window endpoints and record rates
below 27 authoritative states/s on a
clean connection. Impaired lanes reserve 20% of configured downstream bandwidth
for control/events, using measured average serialized snapshot size to derive
the state-rate budget, capped at 27Hz with a useful floor of 10 Hz. The gap budget
allows worst configured round-trip propagation, one bounded 64 KiB queued chunk,
and 100 ms scheduling; clean gaps are compared with 250 ms. Whole-window state rate
includes rejoins, whose individual setup deadline is 10 s. First/last delivery
gaps, final state age and population/phase evidence remain in reports, including
failed recordings. Browser and pilot performance observations retain their limit,
worst value, difference and overrun count. Numeric overruns are report-only: no CI warning or failure. Missing streams, invalid snapshots, incomplete RTT measurements and workload
generator failures remain errors. Review intentional feature costs before
adjusting the reference budgets.
The private control socket finalizes server metric windows at both measurement
boundaries and requires every intervening window identity exactly once.

Proxy transmission scheduling overlaps propagation of queued chunks, preserves
FIFO order under jitter, and serializes their bytes at the configured rate.
Arrival timestamps are captured before the bounded transform queue. Input
backpressure releases at serialization completion; a separate bounded queue
handles propagation and downstream backpressure. A real 2 MiB sustained-transfer
test verifies normal-profile throughput within 20% of serialization plus maximum
propagation time, exact byte order, and timer/socket cleanup.

The required CI combined traversal lane uses CPU 4× plus the normal 5 Mbps
profile. A separate clean combat lane checks the larger world. The original
normal and degraded combat stress artifacts are retained as failed historical
runs, excluded from comparisons and superseded for network attribution by the
two-stage proxy correction. That earlier model released writable backpressure
after delivery, which could artificially reduce sustained throughput. Corrected
model runs must establish the current outcome; neither required CI lane proves
that impaired combat meets its budget.

For investigation, the earlier degraded run delivered 76 combat snapshots
totaling 1,622,869 bytes in 15.3744 s (21,353.5 bytes/snapshot), compared with
8,270 bytes in warmup. Its measured payload alone implies an ideal 1 Mbps
ceiling of 5.85 snapshots/s before events, below the useful 10 Hz floor. The
earlier normal run delivered 255 snapshots in 15.431 s (16.5 Hz), averaging
27.2 KB, compared with 11 KB in warmup. These figures describe those historical
workloads, not verified corrected-proxy throughput. Payload optimization requires
comparative protocol and correctness measurements before any production change.
Physical-phone acceptance and qualifying A/A and A/B sessions remain separate.

The load driver retains its fixed reference 27 Hz/250 ms thresholds. Those deliberately
differ from the mobile runner's warmup-payload-derived impairment budgets; a load
capacity observation and a mobile delivery observation answer different questions.

## Deterministic work per frame

Run from `/Users/johnsolly/code/GeoRoids`:

```sh
node --import tsx scripts/measure-frame-work.ts --output .performance/work-a1.json
node --import tsx scripts/measure-frame-work.ts --output .performance/work-a2.json
```

The compiled seeded scene runs the same 120 measured simulation frames after
30 warmup frames. A separate observation context records actual per-frame update
and render calls, Canvas/Path2D method calls, local ship and fixture entity
position reads, and contour endpoint reads. These are scoped work counters, not
an instruction count for the entire application. No observation hooks run in the
timing context or shipped gameplay. Legacy aggregate Canvas counts are aliases;
use only phase-prefixed vectors when comparing work, never sum both.

Collect two fresh reports for each product arm with a fixed harness, then compare:

```sh
node --import tsx scripts/compare-frame-work.ts \
  --baseline .performance/work-a1.json --baseline .performance/work-a2.json \
  --candidate .performance/work-b1.json --candidate .performance/work-b2.json \
  --output .performance/work-comparison.json
```

The comparison requires exact repeats within each arm, matching source/harness
and environment evidence, identical game outcomes, and matching final-frame
pixels. Intentional visual changes require `--allow-visual-change`; the report
still exposes pixel inequality. The pixel witness covers the final fixture frame,
not every possible game state. Each metric reports its own per-frame delta.
Fewer endpoint reads and fewer strokes are different kinds of work; neither alone
proves faster presentation. Continue timing comparisons alongside these counts.

### Report-only frame work budgets

Pass `--budget docs/performance/frame-work-budget.json` to
`scripts/measure-frame-work.ts` to compare every observed frame with the agreed
limits. Numeric overruns are recorded and exit successfully without emitting warnings. The raw report
retains all vectors plus each budget, observed maximum, difference and number of
over-budget frames, including observations below the threshold. Missing metrics,
invalid values, incomplete recordings and changed source provenance remain errors.
Budget adjustments are explicit decisions about feature costs; do not silently
replace the baseline to hide a change.

Performance review is a monthly routine for GeoRoids development. Compare retained
results with the previous month and agreed reference values, review feature costs,
and adjust references explicitly when warranted. CI collects evidence; numerical
performance changes do not generate warnings or block development.
