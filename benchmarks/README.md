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
trusted joystick/fire events. WebKit is available with `--browser webkit`, but
desktop WebKit with touch emulation is not an iPhone measurement.

The load driver uses the real protocol and decoder, realistic input/shoot
messages, phased admissions, pings and resync requests. Every pilot uses the
current snapshot protocol. Free/handoff motion uses epoch-tagged
poses; constrained motion uses input messages. Measured authoritative
acknowledgment advancement for commands sent during measurement is required, so
warmup acknowledgments and rejected commands cannot pass as useful load. Each
negotiated session must deliver contiguous sequences. The diagnostic delivery
checks require at least 27 states/second across the complete measured window,
including rejoins, and no gap above 250 ms; these are declared workload checks, not calibrated capacity
budgets. Every offered pilot must finish joined with fresh authoritative state.
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
configured per-chunk delay is an approximation; report measured RTT and delivery
intervals rather than treating settings as observed network latency.

Isolated architecture experiments are `collision-experiment.ts` and
`protocol-experiment.ts`; decisions and limits are in
[`docs/performance/implementation-status.md`](../docs/performance/implementation-status.md).
