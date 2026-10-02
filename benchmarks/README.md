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
npm run benchmark -- measure wire-ledger --revision HEAD --seed 42
```

The client viewport can be `desktop`, `touch-portrait`, `touch-landscape`, or `tablet`.
The other runners use `desktop`. The seed defaults to `42`.

Compare two revisions with the same workload:

```sh
npm run benchmark -- compare client --baseline REV --candidate REV --seed 42 --viewport desktop
npm run benchmark -- compare server --baseline REV --candidate REV --seed 42
npm run benchmark -- compare codec --baseline REV --candidate REV --seed 42
```

Comparison is available for client, server, and codec. Transport is a realtime,
nondeterministic sample and accepts one revision only. The wire ledger also
accepts one revision: review its bytes and decoded-state receipts separately
instead of applying the framework's timing comparison to a byte diagnostic.

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
| `server` | Direct `GameEngine` ticks with two real loopback player peers. |
| `codec` | Seeded snapshot fixtures across shared and staggered recipient baselines, with 1, 2, 5, 10, and 25 recipients. |
| `transport` | Two real loopback clients against an owned child server for the default two-second window. |
| `wire-ledger` | A seeded real engine and broadcaster with two owned real loopback clients, 60 warmup and 240 measured simulation ticks. |

The client timing context uses native `requestAnimationFrame` timestamps and
`performance.now()`. `updateMs` and `renderMs` are synchronous CPU submission
times. `frameIntervalMs` is a separate scheduling observation. None of these
values proves that a GPU presented a frame. A second fresh observation context
counts actual `CanvasRenderingContext2D` and `Path2D` API calls, including HUD and
environment probes. Those counts describe submitted API work, not GPU draws, and
are kept outside the timed result.

### Snapshot wire ledger

Server and wire-ledger fixtures own a separate deterministic UUID stream before
constructing the engine. IDs remain unique valid UUIDs, independent of gameplay
RNG consumption; full state and row order remain comparison evidence. The owner
rejects overlapping or mismatched crypto bindings and restores the original
Node bindings after its sockets close. Production randomness is unchanged.

The `wire-ledger` scene advances the real engine at a controlled 60 Hz clock and
offers a real broadcast every second tick. It awaits both actual client receipt
and the server's send callback before offering the next snapshot. Each decoded
snapshot must equal an independent recipient oracle from public engine state,
including current rounding, asteroid interest, equipment privacy, own pickups,
projectiles, tags and global spider/map knowledge. Every raw text message is
retained with a hash and replayed through a fresh decoder for each pilot.

The scene uses public engine motion admission and shot admission APIs, one real
Mineral Scan activation, moving spiders and a forced keyframe followed by a
delta. Positive controls require measured accepted movement, accepted/observed
shots, both scan and normal snapshots, changed spider fields, and keyframe/delta
delivery. This tests engine/broadcaster transport; it does not claim production
join authentication, client command validation, persistence or browser play.

Per-pilot receipts partition every snapshot UTF-8 byte into envelope/metadata,
keyframe fields, delta fields and collection add/update/remove/order work.
The containers/punctuation bucket includes their property names and syntax.
Bucket sums must equal the exact emitted payload. Events and control messages
remain in the complete stream and have separate totals by type.

The uncompressed text-frame header calculation (2, 4 or 10 bytes) must reconcile
with actual public TCP `bytesWritten` totals for each accepted socket, both for
the entire post-upgrade window and the measured window. HTTP upgrade and close
handshakes lie outside these windows; unexpected compression, control frames or
fragmentation cannot silently pass the accounting equality. TCP/IP and TLS
headers are not counted. Keep raw hashes unchanged; the additional normalized
state hash aliases opaque runtime UUIDs solely for repeated outcome comparison.

Broadcast and decode CPU timestamps end before oracle equality, hashes, byte
partitioning and replay. Send interception bookkeeping is included in diagnostic
broadcast submission time. Byte rates divide by simulated seconds, not elapsed
wall time. Serialized draining removes congestion by design: this scene cannot
establish constrained-network latency, client state freshness, sustained
throughput or enjoyable slow-connection play. Follow byte candidates with the
owned real-time constrained gameplay lane. Captures fail loudly at 128 MiB or
20,000 messages, and failed samples retain their bounded partial wire evidence.
No in-game Wiki page changes for this measurement tool.

### Compiled client scene presets

The default `--scene stationary` retains the original Hauler scene and its
30 warmup / 120 measured frames. Three additional presets lock their kit,
participants, activation timing and frame counts:

| Scene | Warmup / measured frames | Actual fixture action |
| --- | --- | --- |
| `scan-transition` | 30 / 240 | A Scout activates Mineral Scan once before the first measured update; normal updates expire it and return the camera to flight scale. |
| `scan-wide` | 60 / 45 | A Scout activates once before warmup; the measured window stays wide and ends with 15 active frames remaining. |
| `spider-field` | 30 / 120 | A Hauler renders ten fixed non-crawler spiders supplied through the public server-snapshot field boundary. |

Run from `/Users/johnsolly/code/GeoRoids` or a clean linked GeoRoids worktree:

```sh
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport touch-portrait --dpr 3 --scene scan-transition
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport touch-portrait --dpr 3 --scene spider-field
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport touch-portrait --dpr 3 --scene scan-wide
```

These remain compiled client diagnostics without a live socket or product event
loop. One harness RAF calls the actual game update and render once per frame;
the public authoritative-pose mode keeps the pilot stationary. A successful
offline scan activation proves the rendering fixture, not server admission or
interest filtering. Snapshot spiders exercise drawing, infestation contours and
foot placement; the client does not simulate their authoritative movement.

New scenes use a fixed presentation `performance.now()` advancing at 60 Hz.
CPU measurement uses the saved original native clock, and RAF intervals remain
native. Scan activation is an arranged action outside the update/render timing
boundaries; no active timer or cooldown is refreshed during measurement.
Fresh timed and observed contexts must finish with identical participant and
ability outcomes. All compiled scenes retain the maximum of 3600 total frames.

The observation context records the actual world transform and virtual viewport,
plus native spider painting and canvas creation. Scan transition captures
composed pixel hashes at measured frames 6, 60, 119, 120, 126 and 240; other new
scenes capture their declared checkpoints including the final frame. Capture and
hashing occur outside timing and work counters. Hashing completes before the
next observation RAF, bounding retained image memory. These checkpoints detect
an omitted transition that a returned final frame would conceal.

Dynamic scenes explicitly omit `contour.endpointReads`: widening can replace the
terrain array, so initial-array probes would undercount actual work. Reports
declare that coverage gap and retain native Canvas/Path2D calls, camera outcomes
and pixels. Stationary endpoint probes remain unchanged. Native submission
counts and canvas creation are separate kinds of work; neither establishes GPU
completion, a phone speed improvement, or physical-device acceptance.

The server runner fixes `Date.now()` and seeds `Math.random()` while retaining
native `performance.now()` for tick timing. It creates two actual loopback player
connections through the seeded engine. Natural authoritative
simulation continues during warmup and measurement, so asteroid, loot, and
satellite-pickup counts before and after are part of the result.

The codec runner checks every decoded message against the original fixture state,
including keyframes, deltas, and divergent recipient baselines. Its byte counts
use UTF-8 application payloads from the JSON snapshot envelope. They do not count
WebSocket transport framing. `*-encode-serialize-ms` measures frame creation and
envelope serialization. `*-parse-decode-ms` measures one decoder-owned envelope
parse plus snapshot validation, reconstruction, and retained-baseline copying.
The serialized envelopes are prepared before that timed region.

Current snapshot streams require a full initial world and explicit recovery or
rejoin keyframes. Otherwise the encoder uses a delta only when its actual UTF-8
envelope is strictly smaller than a full frame; there is no forced keyframe
interval. Codec and wire-ledger reports retain
`keyframePolicy: initial/recovery/strictlysmaller`. The wire ledger independently
replays each complete initial stream and requires measured delta work, rather
than manufacturing periodic full frames. Historical codec and wire receipts
retain the keyframe policy measured at their recorded revision.

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

Renderer comparisons must reuse the same built assets across every A/A and A/B
session. Build the first clean-network client session normally, then put
`--reuse-build` immediately after `--benchmark-client` for subsequent sessions:

```sh
./scripts/test-runner.sh --benchmark-client --renderer canvas --network clean --viewport touch-portrait --dpr 3 --cpu-slowdown 4 --scenario combat --warmup 30 --seconds 300 --output .performance/renderer-first.json
./scripts/test-runner.sh --benchmark-client --reuse-build --renderer webgl2 --network clean --viewport touch-portrait --dpr 3 --cpu-slowdown 4 --scenario combat --warmup 30 --seconds 300 --output .performance/renderer-next.json
```

These two commands illustrate build ownership; the comparison still requires
three distinct A/A pairs and three alternating A/B pairs with 300 foreground
seconds and 300 completed measured input actions per session. The first build
runs the usual Wiki/type/build checks and writes
`.performance/benchmark-client-build.json` only after success. Reuse verifies
the same checkout/revision, Git-visible files, ignored environment files, build
environment, lockfile, Node version and every built asset. It starts a fresh
owned preview/server pair and never attaches to existing services. Changed or
missing inputs, assets or receipt fail before measurement. Other build commands
can change `dist/` and invalidate reuse. An impaired-network proxy receives an
ephemeral port, so reuse is rejected unless its actual WebSocket URL exactly
matches the successful build; use clean network for frozen renderer cohorts.
The receipt is local benchmark evidence and does not replace `npm run gate`.

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
first measured movement acknowledgment. Dead pilots wait for the normal respawn on their existing socket; `gameJoins`
records actual joins separately from TCP connections. It measures generator CPU, memory and event-loop
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

Traversal prepares one player with the current ambient populations. Combat
prepares five players (one browser plus four real-protocol peers),
80 asteroids, and six Earth-observation satellite pickups. A private Unix
socket in the runner's temporary session directory validates the complete
participant set before synchronous between-tick arrangement. It preserves player
motion sessions, advances placement epochs through the existing authoritative
placement path, and requests a fresh snapshot baseline per recipient. Every
participant must observe that baseline before warmup. Game rejoins repeat setup.
The protocol peers share the load runner's `Pilot` implementation.
Its `snapshotHandlingMs` samples cover the inbound callback from the
decoder-owned parse through benchmark state and witness updates.
Their projectiles use current shared laser tuning and inherited ship velocity.
The September 12 driver correction replaces a fixed speed of 10 that the newer
authority rules reject after the slowdown. That changes admitted combat work;
older peer-shot workloads are not interchangeable timing controls. Failed client
runs retain collected intervals in both the scenario and aggregate measurement.

Each fixture reports the seed, full initial world manifest, hash, epoch, actual
participant IDs and expected snapshot sequences. Random entity IDs are excluded
from the repeatability hash. Combat starts in a compact player formation with
four nearby hazards. Per-interval total populations and visible entity centers
record how the workload evolves; positions outside the view, explosions, deaths,
and respawns mean initial counts alone cannot establish comparable rendering
work. Runtime gameplay remains live and is not deterministic replay.

The browser alternates trusted steering/fire presses on anchored one-second slots and attempts
available ability controls. Reports require authoritative movement and
new projectile witnesses. A five-minute run additionally requires at least 300
input steps. Skipped slots are accepted only when their scheduled instant falls
inside a recorded browser respawn recovery of at most ten seconds. Peer setup
and unexplained active-play stalls do not qualify. Recovery duration and skipped
slot counts remain in comparison evidence; at least 300 measured actions and
slots are still required. Raw `inputToRenderMs` samples, rather than the offered step count,
are the acceptance denominator. Finalized server windows are deduplicated by
window ID; overlapping open health windows remain raw evidence only.

Decode timing requirements follow successful applications during measurement.
Every retained measured keyframe and delta must have its own finite decode
sample; missing, malformed or omitted application witnesses reject the report.
A measured stream with no applied keyframes leaves `keyframeDecodeMs` absent,
without invented zero samples. Setup is drained atomically at the browser
measurement boundary and retained as warmup evidence; warmup and join timings
cannot satisfy measured decode requirements. Parse, delta, apply, join, renderer,
input and gameplay requirements remain mandatory.

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
or `--trace .performance/game.trace.json.gz` to the production-client command
with Chromium and a single viewport. Profiling runs only around the measured
phase and preserves a partial artifact on failure. A trace uses the Chrome
DevTools Protocol streaming mode with bounded gzip output and timed stream reads.
The trace contains `performance.mark`/`performance.measure` entries named
`georoids-benchmark:measurement-start`, `georoids-benchmark:measurement-end` and
`georoids-benchmark:measured-phase` so the measured window is auditable in the
trace viewer. The marks bracket the observation loop after profiler/peer setup;
their browser timestamps differ from the host measurement boundaries by the CDP
delivery time. It writes the exact same-origin JavaScript responses beside it under
`.performance/game.trace.json.gz.bundles/`, with `manifest.json` recording each
URL, status, byte count, advertised `Content-Length` when valid and SHA-256.
Responses whose valid `Content-Length` exceeds the limit are rejected before
`response.body()` allocation;
the decoded body is checked again afterward because Playwright does not expose a
streaming response-body cap for chunked or content-encoded responses. The
manifest records these limits and the resulting limitation. `profileRecorded`
disqualifies either profiling mode from timing comparison. Reports also capture
Chromium GPU devices, renderer, feature status and the effective
`browserChannel`. `--chromium-gpu` selects Playwright's `chromium` channel with
`--enable-gpu` and requires accelerated Canvas/compositing/rasterization plus a
non-software renderer; the default Chromium channel remains the Playwright
bundled browser. Unsupported WebKit GPU inspection is explicit. Neither browser
emulation nor a software renderer establishes the behavior of a phone GPU.

Add `--headed` to open a visible browser window for desktop captures. Headless
remains the default. The report records the mode in browser metadata,
measurement parameters and scenario constraints, so paired comparisons cannot
mix headed and headless runs. Keep the benchmark window in front and let its
scripted inputs drive the ship. A visible window alone does not prove hardware
acceleration; add `--chromium-gpu` to require the checked GPU path.

Run this from `/Users/johnsolly/code/GeoRoids` or the absolute implementation
worktree path, using the actual display DPR. The desktop case is 1920×1080 CSS
pixels; reports retain both CSS and backing dimensions and require the admitted
page and game canvas to be visible:

```sh
./scripts/test-runner.sh --benchmark-client --viewport desktop --headed --chromium-gpu \
  --dpr 2 --scenario combat --seed 42 --warmup 30 --seconds 180 \
  --output .performance/desktop-combat.json
```

Combat begins with five pilots, 80 asteroids, and six pickups. Review the
`populationSamples` visible counts and authoritative projectile witnesses before
interpreting timing. The desktop combat pilot offers trusted Space presses on an
independent 250 ms schedule between its one-second steering steps. That matches
the Scout's 250 ms cooldown; the Hauler's 280 ms cooldown and five-live-laser cap
can reduce admitted shots. `desktopFire` records measured offered/completed
presses and skipped slots. Pending presses never overlap, and firing stops during
recovery and cleanup. Desktop traversal presses Space once per step; each of the
four combat peers offers two shots per second.

Use `--scenario dense-combat` for an additional compact asteroid workload. It
starts the same five pilots, 80 ordinary seeded asteroids and six pickups, but
places all asteroids on a compact 110-unit grid with zero initial translation.
Material, health, shape, rotation, and reflective-pocket offsets remain intact;
every initial asteroid clears the hulls and Town Square hearth. The hashed
fixture manifest records the layout and complete starting asteroid state.

After arrangement, ordinary physics, firing, damage, splitting, towing and
impulses run unchanged. Rocks are never topped up or reset during the run; a
peer rejoin fails this scenario instead of reseeding its field. Warmup can
consume asteroids, and a finite field can still deplete. Review per-second visible
population and actual damage/tag/destruction witnesses over the complete measured
window before calling it sustained collision load. A dense starting count alone
is insufficient. Normal `combat` remains the existing sparse drifting fixture.

Use `--scenario regional-combat` with one explicit viewport to measure the live
production regional field. The five pilots keep their ordinary server-chosen
spawns and current motion epochs. Preparation only verifies the participant set
and requests fresh keyframes; it never clears the world, places ships or rocks,
creates a fixed asteroid population, resets abilities, or supplies health.
The normal game loop wakes and sleeps sectors while the existing trusted
steering, firing and ability inputs run.

The private socket preserves its 0600 permission and 1 MiB response bound.
Initial and final regional manifests are captured outside measurement and retain
the actual mode/counts, a digest of every active asteroid row, and at most 32
asteroid samples sorted by actual ID. Pickup, map asset and spider samples are
also bounded; these receipts contain no player credentials. Per-interval scalar
field receipts prove that regional mode remains active, alongside real nearby
population and applied-snapshot freshness observations. A natural manifest is
an observation of an evolving world, so its digest can change as rocks drift or
pilots harvest them. It is not the fixed-fixture identity used by renderer A/B
comparisons; the comparison CLI continues to reject this separate scenario.

Regional runs fail if a measured pilot rejoins, the field changes to fixture mode,
the field becomes empty, or normal nearby asteroid snapshots are missing. Runs
of at least 30 seconds additionally require server-accepted Mineral Scan states
carrying asteroids beyond the ordinary radar circle, matched by sequence and
server clocks to the real client's successful application. A due scan remains
pending while authoritative cooldown or UI readiness blocks trusted input, and
retries at the next input slot; beginning measurement also queues a scan. No
world timer is reset. `regionalWorld.scanEvidence` retains bounded input
decisions, actual ability requests, accepted events, and matching applied
snapshots, while warmup scan counts remain separate from measured work. The
opt-in client recorder retains a scalar receipt after every successful application,
including its actual owner, session, sequence, both server clocks and browser
application time. These receipts survive session resets until drained; a browser
monotonic measurement boundary excludes undrained warmup work. A short scan can
therefore qualify between observation polls. Missing, unmatched or omitted
application receipts fail qualification. Each drain retains at most 4096 receipts;
the regional report retains at most 60,000 matched application witnesses.

After browser cleanup, a private 0600 artifact beside the report retains the first
32 successfully decoded measured browser snapshot envelopes of at least 64 KiB, within an
8 MiB artifact ceiling. It records exact UTF-8 payload sizes, hashes and explicit
frame/byte omissions. Capture never retains join/resume controls, and performs no
per-field byte partitioning during measurement. Use this actual nearby-world
evidence for later geometry/collection analysis; old synthetic ledger shares do
not establish natural-world byte costs.
Ordinary damage, death, respawn, pickups, map discovery, spiders and loot remain live gameplay; their
actual populations and existing combat witnesses remain in the report. Shorter
runs report whether a scan was observed and cannot claim scan workload coverage.

`combatWitness` records actual `playerDamaged`, `asteroidTagged`,
`asteroidDestroy`, and `shockwave` messages. Player damage preserves the target,
attacker, damage, remaining health, and destruction flag. An `asteroid` attacker
identifies a ship/asteroid collision; `ricochet`, `spider`, and `boundary` identify
other hazards. Asteroid tags retain the asteroid and shooter IDs and tag expiry.
Supplemental health decreases come from successive measured snapshots. The
report retains receipt times, event origins or the last known target position, and
whether that position lies inside the last sampled browser viewport with the
camera sample's age. Both successful and failed reports preserve this evidence.
Each event series retains at most 4,096 rows and reports omissions separately
from total counts. Snapshot baselines reset across joins and fixture arrangement.
Health decreases do not identify their cause; furnace consumption is reported
when supplied by a destruction event. These observations do not impose a minimum
visible laser population or collision count, and missing objects alone never
count as collisions.

Chromium runs record successful gameplay WebSocket negotiation independently of
`--trace`, including the negotiated extension header. Use the same harness when
checking compression negotiation across runs; that witness does not claim that
an unprofiled run is otherwise unchanged. The client uses the same
`GEOROIDS_BENCHMARK_COMPRESSION` selection as the owned server adapter: `none`,
`deflate-level1-no-context`, or `deflate-level1-no-context-8k`. The original
candidate retains threshold 1024 bytes; the 8 KiB candidate changes only that
threshold to 8192 bytes. Both remain unqualified benchmark experiments, with
production compression disabled. The report records the requested configuration
and actual negotiation. Threshold is a local server option, so the extension
header cannot distinguish these candidates; the strict server CPU receipt must
retain the same named mode as the requested configuration. Candidate
qualification requires the browser's successful 101
extension header to prove both no-context directions; peers must also negotiate
`permessage-deflate`. A `none` run must negotiate no extensions.

Private O(1) process CPU probes bracket measurement and retain raw cumulative
user/system microseconds, the server monotonic interval and driver-side query
brackets. `serverProcessCpu.measurement` includes the entire server process,
including zlib worker threads; utilization can exceed 100% when workers run in
parallel. Driver `generatorCpu` and main-isolate CPU profiles remain separate
observations. Regressed counters, a missing boundary or changed compression mode
fail qualification. Transport and gameplay budgets are unchanged.

Every benchmark-client lane routes gameplay through an owned TCP proxy. Both raw
TCP sender legs disable Nagle, matching the WebSocket endpoints. The clean lane
adds no bandwidth cap or scheduled delay; platform scheduling, receiver ACKs
and backpressure still apply. `proxyTransport` retains live
start/end counters from the private control socket and the driver's separate
query brackets. Its measured bytes subtract the start totals, and rates use the
proxy's monotonic elapsed time. Replies must belong to the same proxy instance
and declared lane, have safe monotonic cumulative counters, and witness traffic
in both directions without transport failures.

These bytes count raw stream chunks admitted to outbound delivery, including
WebSocket/HTTP framing and any in-flight warmup bytes that cross the window.
They exclude TCP/IP headers and retransmission overhead. Start probes follow
warmup and qualification; end probes immediately follow observation before
trace/tail work or cleanup. CPU and transport probes start together but retain
independent clocks and query brackets. Failed observations retain their actual
partial end counters; failed or missing probes remain errors and null replies,
never invented zeroes. `constraints.proxy` file totals and boundary peak counters
remain whole-session diagnostics, not measured-window bytes or maxima.

Real-time performance budgets allow two states for window endpoints and record rates
below 27 authoritative states/s on a
clean connection. Impaired lanes reserve 20% of configured downstream bandwidth
for control/events, using the warmup average serialized snapshot size to derive
the state-rate budget, capped at 27Hz with a useful floor of 10 Hz. The gap budget
allows worst configured round-trip propagation, one bounded 64 KiB queued chunk,
and 100 ms scheduling; clean gaps are compared with 250 ms. Whole-window state rate
includes rejoins, whose individual setup deadline is 10 s. First/last delivery
gaps, final state age and population/phase evidence remain in reports, including
failed recordings. Browser and pilot performance observations retain their limit,
worst value, difference and overrun count. Numeric overruns are report-only: no CI warning or failure. Missing streams, invalid snapshots, incomplete RTT measurements and workload
generator failures remain errors. Review intentional feature costs before
adjusting the reference budgets.
The degraded profile is 125,000 bytes/s downstream and 32,000 bytes/s upstream
per connection, with 90±60 ms propagation in each direction.
Its nominal minimum rate is `max(10, min(27, floor(0.8 * 125000 / warmupAverageBytes)))`,
with the same two-state endpoint allowance. Both delivery gaps and every retained
independent server-to-applied age must stay within 924.288 ms; clean limits are
27 Hz and 250 ms. Candidate qualification requires every browser and peer to
meet the numeric and workload limits, even when the runner exits successfully
and the report status is `passed`.
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
