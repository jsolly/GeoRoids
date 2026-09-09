# GeoRoids testing and performance strategy

## Recommendation

Extend the existing benchmarks into a repeatable measurement system, protect gameplay with behavioral tests, then optimize the work that dominates on real phones. Keep the current Vite client, Canvas2D renderer, Node server, and negotiated WebSocket protocol while establishing evidence. A renderer rewrite, binary protocol, or multiple Railway replicas should require a demonstrated bottleneck and a passing compatibility experiment.

The first implementation should produce an automated report connecting frame pacing, client update/render/decode time, server tick deadlines, and transport pressure to the same workload and release. Follow it with small changes to terrain traversal, HUD work, clock recovery, and collision candidate selection where traces show material cost. Every optimization must preserve authoritative combat, touch controls, readable projectiles, and reconnect behavior.

This is an implementation plan, not a claim that the app already meets the proposed targets. Physical Android/iPhone measurements, Railway capacity tests, and production performance distributions remain unmeasured. Complete those measurements in the phases below before declaring a supported capacity or a mobile frame-rate guarantee.

## Evidence and current architecture

The inspected repository baseline is `54d8c18d4ce25b3ea6af731582bd615666761a85`. Repository observations below refer to that revision; links use local paths for navigation. Public documentation was checked on September 8, 2026. Recheck the baseline against the implementation branch before editing because rendering and protocol work is active.

| Area | Existing behavior and evidence | Consequence for the plan |
| --- | --- | --- |
| Client loop | [eventLoop.ts](../src/core/eventLoop.ts) invokes `GameController.updateGame(dtMs)` and `renderGame` through animation frames. [canvas.ts](../src/rendering/canvas.ts) draws terrain, entities, effects, and HUD. | Profile this live path, including message application between frames. |
| Canvas resolution | `CanvasManager` creates an opaque 2D context and sets backing dimensions to visual viewport dimensions, without multiplying by device pixel ratio. | A generic recommendation to cap DPR would duplicate an effective cap of one. Any higher-resolution mode is a quality/cost experiment. |
| Rendering reuse | [contourRenderer.ts](../src/rendering/contourRenderer.ts) batches strokes by contour level and rejects offscreen segments. The arena boundary already has culling; HUD layout already caches environment reads. | Optimize remaining traversal and repeated content rather than reintroducing these changes. |
| CPU benchmark | [benchmark-game-loop.ts](../scripts/benchmark-game-loop.ts) runs desktop, touch portrait, and touch landscape with production and loaded fixtures. It warms 180 frames, then measures seven batches of 120 synchronous frames. | Useful for CPU comparisons, not presentation timing. Touch cases currently pass `includeUpdate: false`. |
| Simulation | [GameEngine.ts](../server/core/GameEngine.ts) advances fixed simulation frames at 60 Hz and catches up using [gameClock.ts](../shared/gameClock.ts). | Measure scheduled deadlines and accumulated debt in addition to `advanceOneFrame` cost. |
| Broadcasting | [GameStateBroadcaster.ts](../server/services/GameStateBroadcaster.ts) broadcasts at 30 Hz, shares canonical snapshot preparation, and manages per-socket baselines and backpressure. | A server frame benchmark alone excludes a major capacity boundary. |
| Protocol | [snapshot-v1.md](protocol/snapshot-v1.md) documents negotiated deltas, keyframes, atomic validation, legacy fallback, resync, and enhanced capabilities. | Extend the existing codec and compatibility tests. Do not propose delta snapshots as new work. |
| Collision | [CollisionAuthority.ts](../server/core/CollisionAuthority.ts) maps entities into collision rows; [combat.ts](../shared/combat.ts) checks ship/asteroid combinations and ship pairs with nested loops. | Candidate growth and temporary allocations are plausible scaling costs, not measured bottlenecks yet. |
| Mobile interaction | [touchControls.ts](../src/input/touchControls.ts) supports steering, firing, ability, and shield input with stateful pointer handling and cached button state. | Test sustained multitouch and lifecycle transitions, beyond button visibility. |
| Test enforcement | [ci.yml](../.github/workflows/ci.yml) runs static checks, runner contracts, unit tests, and build. It does not run gameplay browser or server integration suites. | Add bounded behavioral integration coverage to CI without weakening the existing gate. |
| Diagnostics | [diagnostics.md](diagnostics.md) describes correlated bounded logs, release IDs, queue loss, and sampled state checkpoints. | Reuse these mechanisms; add aggregate timing metrics rather than per-frame logs. |

### What existing numbers establish

The protocol document records a September 7 local fixture comparison of 31,450 legacy bytes per tick versus 8,046 negotiated bytes, with combined encode/decode cost increasing from 0.165 to 0.917 ms per tick. It also records September 8 shared broadcast work at 0.656 ms for ten recipients versus 3.053 ms in the previous implementation. These historical synchronous measurements demonstrate a bandwidth/CPU tradeoff and shared-work savings under their stated fixtures. They do not establish current phone cost or production capacity.

An exploratory run of `npm run benchmark:game-loop` completed at the inspected revision on Node 24.16.0. Its [retained output](performance/baseline-2026-09-08.txt) contains every benchmark summary and batch mean. Structured server diagnostic rows were omitted from that attachment. The loaded server fixture started with 80 asteroids and 15 loot objects and finished with 69 asteroids and 34 loot objects, showing why entity counts and workload evolution matter.

Treat this single run as evidence that the tool works and needs stronger experimental controls. It used headless Chromium on a shared macOS host, a Vite development server, no real network session, and no controlled thermal state. Some batches vary sharply; do not derive FPS, confidence intervals, phone capacity, or an optimization ranking from them. The attachment's filename uses the local execution date.

## Measurement design

### Separate four questions

Loading measures how quickly a new player reaches the menu and becomes able to control a joined ship. Gameplay measures frame delivery, input response, decode/application stalls, and memory over sustained play. Server capacity measures the largest declared workload that maintains tick deadlines and delivers usable state. Developer performance measures startup, build, and test turnaround.

Vite's performance guide is relevant to transforms, startup, and build diagnostics, including `--profile`. It does not establish the cost of the running Canvas game.[^1] Vercel Observability can explain static delivery, middleware, and build behavior, but the authoritative game loop runs on Railway.[^2] Use separate dashboards and join them by client/server release IDs.

### Proposed budgets

The following are initial engineering targets, not measured guarantees. Calibrate them in phase 1 against a named midrange Android phone and a supported iPhone. If a target is infeasible, record the evidence and choose a deliberate quality tier; do not silently loosen thresholds after a regression.

| Measurement | Initial acceptance target | Definition and use |
| --- | --- | --- |
| Normal mobile play | 60 Hz mode: p95 frame interval at most 20 ms; p99 at most 33.3 ms; at most 1% intervals above 33.3 ms | Five-minute foreground runs after warmup. Record display refresh rate and all long gaps. |
| Low-power mode | Explicit 30 Hz rendering: p95 at most 36 ms; p99 at most 50 ms | Keep authoritative simulation, input semantics, and combat timers unchanged. |
| Client CPU headroom | p95 update + draw submission at most 10 ms in 60 Hz mode | Measure real frames; separately report message decode/apply. GPU/presentation time is additional. |
| Snapshot application | p95 parse + validate + decode + manager application at most 3 ms on target phones | Use realistic keyframes, deltas, and burst recovery; report each separately. |
| Local input feedback | p95 event-handler arrival to first affected render submission at most 50 ms | Browser proxy for responsiveness, not touch-to-photon latency. Validate physical feel with device recording. |
| Join | p95 Play-to-first-controllable-authoritative-frame at most 2 seconds under the declared normal network | Include connection and join errors in the denominator; report cold and warm page loads separately. |
| Server simulation | p99 `advanceOneFrame` at most 8 ms at declared supported load | Reserve time within the 16.67 ms tick interval for transport, GC, and other work. |
| Server transport work | p99 broadcast preparation at most 8 ms at supported load | Also measure combined event-loop duty and callback delay; independent p99s do not prove schedulability. |
| Server deadlines | Fewer than 1% ticks start over one tick late; no growing accumulator debt during steady load | Record timer lateness, catch-up count, event-loop utilization/delay, and maximum gap. |
| Recovery | At least 99% successful scripted reconnects; p95 first valid state within 2 seconds after transport restoration | Separate retained-player resume from a fresh join after grace expiry. |
| Memory and queues | No sustained growth after warmup; all queues bounded and all loss accounted for | First establish steady-state variance. Fail leaks or unbounded queues immediately; set numeric RSS limits per tested deployment. |
| Delivery | Field p75 LCP at most 2.5 s, INP at most 200 ms, CLS at most 0.1 | Supplement with menu-ready and playable timing; these metrics do not certify gameplay smoothness.[^3] |

For every metric, report sample count, duration, p50/p95/p99 where meaningful, maximum, and failures. A failed join must not disappear from a latency distribution because it never finished. Split load, menu, play, respawn, and background periods instead of mixing incompatible populations.

Use animation-frame timestamp differences as a frame-pacing proxy. They show scheduling gaps, not proof that the GPU displayed every frame. Pair them with browser performance traces and physical-device observation. Animation-frame callbacks follow display scheduling and are normally paused in hidden tabs; explicitly label hidden periods and measure recovery separately.[^4]

### Reproducible benchmark records

Extend the two existing scripts with a versioned JSON output format. Record commit and dirty state, lockfile hash, scenario version, seed, Node/browser/OS versions, CPU/device model, viewport, touch capability, DPR/backing size, browser launch flags, power mode, logging mode, and client/server release IDs. For network tests also record server region/resource allocation, generator host, connection mix, rates, and measured rather than merely configured impairment.

Store raw individual frame/tick samples or bounded histograms with counts, run-level summaries, fixture start/end counts, projectile counts, visible entity counts, candidate collision counts, bytes, queue pressure, and failure totals. Raw data belongs in CI artifacts; keep a small reviewed baseline manifest and report in the repo. Do not include player names, tokens, full production snapshots, or unbounded telemetry identifiers.

Preserve the synchronous benchmark as a diagnostic mode and label its current statistic `p95OfBatchMeanMs`. With seven batches that percentile selects the slowest batch mean; it is not the p95 of individual frames. Add a separate real-time production-build mode that starts from the menu, joins a real server, drives input, and samples the live animation loop. Avoid importing `/src/...` URLs in that mode because those development imports are absent from `dist`.

For comparisons, warm up for 30 seconds, then run five independent paired baseline/candidate sessions of at least three minutes, alternating order on the same idle host. Reset seed, clock, world, camera path, and input trace between runs. Keep coverage, pixel readback, screenshots, and detailed tracing outside timed runs; capture a separate diagnostic trace when needed. MDN recommends measuring the actual expensive work before optimizing JavaScript.[^5]

Compare run-level results, not thousands of autocorrelated frames as independent experiments. Initially report regressions without blocking. After at least 20 unchanged-control runs establish noise, gate a relative regression above 10% only when it also exceeds an agreed absolute floor, initially 0.5 ms for client CPU and 0.2 ms for server tick cost, and reproduces in a confirmatory pair. Preserve the first failure; reruns diagnose it rather than erase it. Hard correctness and queue-limit failures need no statistical allowance.

## Workload and device matrix

| Scenario | Required activity | Primary risk |
| --- | --- | --- |
| Cold arrival and menu | Cold cache, font loading, animated title terrain, nickname entry, Play, successful and failed joins | Startup work, input delay, first-use stalls |
| Ordinary arena | One local pilot, configured bots/asteroids/satellites, moving camera across mountain and boundary | Typical frame cost and gameplay correctness |
| Loaded battle | Ten humans, 80 asteroids, 15 initial drops, configured satellites/pickups; sustained shots and explosions | Render/decode cost, combat interactions, allocation |
| Dense visible battle | Concentrate entities and effects inside the viewport and sweep the camera | Offscreen fixtures can conceal expensive visible work |
| Recovery burst | Disconnect, same-socket rejoin, resync, keyframe after pressure, background/resume | Baseline correctness, catch-up bursts, duplicate effects |
| Long play | 30-minute desktop and mobile sessions, repeated death/respawn and join/leave | Memory leaks, thermal degradation, stale subscriptions |
| Capacity staircase | 1, 5, 10, 25, then 50 connected pilots if admission policy allows, holding entity load constant | Transport fanout and capacity knee |
| Entity staircase | Fixed recipients; separately increase asteroids, projectiles, and clustered collisions | Distinguish simulation cost from connection count |

Reuse existing fixture builders, but version their scenario parameters. Add stationary repeatable snapshots for pure rendering, deterministic evolving worlds for simulation, and real transport sessions for end-to-end behavior. Control wall-clock and RNG dependencies through explicit test inputs; the current benchmark already seeds browser randomness and overrides server time, so extend that work rather than installing a second unrelated fixture system. Record changes in counts as outputs, not necessarily errors, for evolving scenarios.

Use desktop Chromium plus WebKit for automated compatibility, and physical Android Chrome plus iPhone Safari for release evidence. Start with the repository's 390×844 and 844×390 touch cases, then add actual device viewport/safe-area dimensions and a large desktop viewport. Device emulation configures properties such as viewport and touch; it does not reproduce a phone's GPU, thermal behavior, or operating system.[^6] Calibrated Chrome CPU throttling helps prioritize candidates, but real devices decide mobile acceptance.[^7]

Record exact device models and browser versions before accepting the baseline. Test unplugged sustained play with fixed brightness, comparable battery state, and low-power mode both off and on; allow cooldown between comparisons. Keep charging and debugger attachment state consistent because they can alter the experiment. Use device temperature or thermal state where available; otherwise record conditions and frame degradation over time rather than inventing energy measurements.

Network profiles should include local clean transport, a declared normal mobile link, and a degraded link. Initial synthetic settings can be 80 ms round-trip latency/20 ms jitter/5 Mbps down/1 Mbps up, then 180 ms/60 ms/1 Mbps/256 Kbps. These are experiment settings, not claims about all mobile networks. Measure actual RTT and throughput before each run.

Use a controlled TCP proxy or OS network shaping for WebSocket tests and verify that frames are delayed as intended. Do not assume browser HTTP throttling applies all configured impairments to WebSockets. TCP preserves order; packet loss appears as retransmission delay and stalls, not randomly missing application messages. Explicitly dropping a decoded snapshot is a separate protocol fault-injection test.

## Testing strategy for safe refactoring

### Behavioral layers

Keep unit tests fast and focused on shared rules: fixed-step clock behavior, movement and terrain forces, collision geometry, input arbitration, resource consumption, and snapshot invariants. Prefer observable outcomes over singleton internals or private method call counts. Existing tests already cover many of these areas; inventory scenarios and extend missing cases instead of duplicating test names.

Add property-based or generated deterministic cases around the highest-risk algorithms. For snapshots, compare decoded output with canonical public state across add/update/remove/order/clear transitions, keyframes, invalid baselines, and capability mixtures. For collision acceleration, compare against the current brute-force implementation for seeded worlds, edge overlaps, large objects, and swept projectiles. For clocks, compare equal elapsed durations at 30/60/120/144 Hz and inject pauses or backward wall-clock changes.

Use server integration tests for real join/shoot/damage/death/respawn sequences, mixed-version clients, resync, rate limits, delayed send callbacks, disconnect cleanup, and restart behavior. A transport benchmark should fail on invalid state, missed acknowledgments, or stalled gameplay even when socket throughput is high. Keep all integration entry points behind `scripts/test-runner.sh` and its repository-scoped ownership lock.

Browser tests should exercise the shipped UI and network lifecycle. Prioritize two-player visibility, simultaneous steer/fire/ability/shield input, pointer cancellation, orientation changes during input, browser chrome resizing, background/resume, death/respawn, and reconnection. For rendering changes, capture deterministic screenshots of dense combat, terrain, HUD, and projectiles on desktop and touch layouts. Pixel checks verify appearance; separate state assertions verify gameplay.

The repository uses Vitest to drive Playwright's browser API. Playwright Test's auto-retrying assertions require its own runner/assertion integration; do not assume the existing Vitest `expect` waits automatically.[^8] Keep existing bounded waits for observable game state, replace arbitrary sleeps as scenarios are touched, and fail on page errors with diagnostic screenshots and correlated logs. Avoid a wholesale test-runner migration unless measured maintenance cost justifies it.

### CI and coverage

Retain `npm run gate` and the required `CI / ci` status. Add a small serialized integration lane covering boot, move/fire, mobile controls, and mixed-version reconnect, with artifacts uploaded even on failure. Ensure the required CI result depends on that lane rather than allowing auto-merge before it finishes. Install the pinned Playwright browsers and OS dependencies in the runner. Full browser scenarios and load/soak work can run in scheduled or manually dispatched workflows, with owners and failure tracking.

Keep Vitest's one-worker integration settings and process ownership contracts. Unit-test sharding is a separate possible experiment only after proving isolation; increasing integration workers to shorten CI would reintroduce connection bursts and invalid measurements. New failures must fail the run. Any already skipped or quarantined scenario must appear explicitly in the report with a reason and a repair step, never count as a pass.

Add the matching `@vitest/coverage-v8` version in a dedicated tooling change and collect coverage separately from benchmarks. Vitest supports V8 and Istanbul providers; neither is currently declared as a coverage dependency in this repository.[^9] Start with branch coverage reporting for `shared/`, protocol validation, clocks, and authoritative combat. Protect changed high-risk branches and known scenarios before setting a repository-wide percentage. A high line percentage does not prove reconnect semantics or collision ordering.

For each algorithm refactor, include one deliberate mutation or controlled defect that the new regression test rejects, such as ignoring a snapshot clear or missing a cell-edge collision. Remove the defect before committing. This validates the test's ability to catch the failure it claims to protect.

## Client optimization opportunities

### Terrain, repeated rendering, and HUD

The contour renderer still visits every segment to transform endpoints and reject offscreen work. Measure segments visited versus drawn, terrain CPU time, and camera velocity. If traversal dominates, partition cached contour geometry into spatial chunks with bounds and visit only intersecting chunks. Preserve contour ordering, boundary continuity, and the central mountain's visual identity; compare screenshots at chunk edges and during camera movement.

The leaderboard deduplicates and sorts rows during drawing, while the minimap traverses world objects. Cache leaderboard ordering until membership/score changes and update text only when its value changes. Consider a slower minimap content refresh with smoothly updated local position only if traces justify it. Measure complete frames after each change, because reducing one subpath can merely move cost elsewhere.

MDN suggests caching repeated drawing work and reducing costly canvas operations.[^10] Compare bounded vector geometry caches, small prerendered repeated decorations, and unchanged current drawing for the actual scene. Cache invalidation must include viewport, scale, palette, and relevant entity state. Avoid an unbounded whole-world bitmap or a new layer per object, and preserve smooth world coordinates.

### Mobile resolution and quality

Keep the current backing resolution as the baseline. Test optional lower render scales only after measuring GPU/raster pressure; keep touch coordinates and HUD layout in logical CSS coordinates. Repeatedly resizing the canvas reallocates its bitmap and resets context state, so coalesce resize events and skip assignments when dimensions are unchanged. Verify browser chrome transitions, rotation, safe areas, and image smoothing restoration.

If a phone cannot maintain 60 Hz under a representative load, provide a deliberate reduced-effects tier or 30 Hz render mode with hysteresis. Reduce decorative star density, shadow/glow work, or nonessential effect detail before reducing projectile visibility. Do not reduce simulation ticks, fire cadence, collision precision, input sampling semantics, or authoritative network state based on device class. Test that weak devices retain the same combat outcomes.

### Lifecycle, allocation, and workers

Instrument update, draw submission, decode, manager application, and audio/effect creation separately. Use allocation profiles to locate recurring array copies, map/filter chains, text construction, and short-lived render objects. Reuse storage only for proven hot paths with clear ownership; pools that retain obsolete worlds or baselines can trade small GC pauses for leaks.

On hidden-page recovery, neutralize input, reset presentation timing, and reconcile with a current authoritative state. Define how a long absence affects player identity versus reconnect grace. Avoid running hundreds of stale prediction steps before showing the live world. Test pointer cancellation and released fire/ability controls across visibility changes.

OffscreenCanvas can transfer rendering to a worker.[^11] It is a later experiment because this renderer directly accesses managers, DOM-dependent HUD layout, input, and audio. First establish a render-data boundary; then measure total transfer/clone cost and main-thread responsiveness with a fallback. A worker does not remove GPU fill cost. Likewise, evaluate WebGL only after Canvas2D profiling shows a persistent rendering bottleneck that simpler caching and quality controls cannot meet.

## Server and protocol optimization opportunities

### Clock recovery and tick cost

`startGameLoop` currently passes `Date.now()` into `stepClock`, despite a comment describing a monotonic clock. `consumeTickAccumulator` caps frames per call at 60 but retains all unconsumed debt. A long stall can therefore produce repeated large catch-up bursts. This is a code-level risk to test, not evidence of a measured production incident.

Use a monotonic elapsed-time source for scheduling while keeping wall time where domain semantics require it. Specify a bounded debt policy for long suspension: either keep limited debt and expose temporary slowdown, or discard excess simulation debt with an explicit recovery rule. Preserve respawn, invulnerability, projectile lifetime, and resume-token expiration semantics. Validate 100 ms, one-second, and multi-second stalls before choosing the cap; do not simply lower it and shorten timers accidentally.

Add timer-lateness, tick-duration, backlog, GC, RSS, heap, and event-loop metrics. Node 24 provides `monitorEventLoopDelay`, `eventLoopUtilization`, and histograms; convert nanosecond delay values to milliseconds and reset interval histograms after export.[^12] Measure this with production logging enabled, then compare disabled/sampled logging to quantify its cost without disabling diagnostics in production.

### Collision and simulation scaling

Instrument candidate pair counts, actual hits, projectile sweep tests, and time per phase before selecting an index. A uniform grid is the leading experiment for a 2D arena with local interactions. Insert objects into every overlapped cell, include swept bounds for fast projectiles, deduplicate pairs, and preserve deterministic collision priority and tie-breaking. Compare with the existing nested loops over both ordinary and clustered scenes; a grid can cost more at low density or offer little benefit in a cluster.

Audit AI target searches, asteroid motion, and repeated `getAll`/mapping work using the same method. Reuse tick-local views where ownership permits. Keep the authoritative engine as the source of truth and avoid sharing mutable snapshot baselines with simulation objects. Acceptance requires identical gameplay outcomes plus measurable savings at the target workload.

### Snapshot and socket cost

Extend `benchmark-snapshots.ts` with current enhanced capability fixtures, separate server encode and browser decode/apply timings, and synchronized versus staggered baselines. Include non-ASCII names in synthetic data, since UTF-8 bytes and JavaScript string length differ. Measure keyframe bursts and legacy/negotiated mixtures; average delta bytes alone hides recovery cost.

The server already has pending-send and buffered-byte handling for negotiated snapshots. Audit every outbound class, including legacy state and gameplay events, for bounded queues and explicit loss/recovery semantics. WebSocket's browser API does not provide automatic receive backpressure, so bounded application work remains necessary.[^13] Do not discard arbitrary deltas to catch up: decode their required chain or request a keyframe through the existing resync mechanism.

Prefer reducing redundant application work and measuring existing snapshot cadence before another wire-format change. Compare 30 Hz with a proposed lower snapshot rate only alongside interpolation, correction-distance, and input-response measurements. Keep simulation at 60 Hz. If considering interest management, define enter/leave behavior, offscreen projectiles, minimap/leaderboard completeness, and keyframe recovery first; omission cannot masquerade as entity deletion.

Compression is an experiment, not a default switch. The `ws` maintainers warn that per-message deflate adds CPU and memory overhead.[^14] Test compression on/off with realistic concurrency, payloads, phone decode time, RSS, and stalled recipients. A binary protocol must beat the existing negotiated JSON path on end-to-end latency or operating cost while preserving validation and legacy fallback; smaller packets alone are insufficient.

### Railway deployment and capacity

Railway supports regional deployment and replicas, but its optimization guide says requests are distributed across replicas without sticky sessions.[^15] GeoRoids stores its world, player state, and resume state in one process. Adding replicas would create independent worlds and can send reconnects elsewhere. A WebSocket remains on its established connection; the problem is world placement and new connections, not per-frame load balancing.

Keep one authoritative process per world initially. Choose region from observed player RTT and validate resource limits and CPU behavior in the actual Railway service. Extra vCPUs do not automatically parallelize a single JavaScript simulation loop. If capacity requires multiple worlds, implement explicit room identity, admission/matchmaking, room-to-host routing, reconnect routing, and draining before adding replicas. For multi-region play, allocate rooms by region; do not attempt to make one latency-sensitive world span regions through shared storage.

Build a load driver with the existing Node `ws` dependency first so it can reuse the real protocol decoder and commands. Run it in a separate process or host from the measured server and prove the generator is not CPU-bound. k6's current `k6/websockets` module is an alternative when distributed generation and standard load reporting become useful; its documentation recommends that API for new tests.[^16]

Drive actual joins, input at realistic cadence, shots, periodic resync, and disconnects. Distinguish offered load from accepted active pilots and finished scenarios. The production connection limiter is 50 attempts per minute per IP at this revision; phase admissions accordingly, or use explicitly controlled staging configuration and report it. Do not globally disable production protection to make a capacity graph look better.

Use 30 seconds of warmup and at least three minutes per staircase level, then 30 minutes at the last passing level. Repeat the boundary level. Stop escalation on sustained backlog, unbounded memory, protocol errors, or health failure; label that level failed. Publish the last passing configuration with headroom, initially a 30% admission reserve, rather than extrapolating from a no-I/O loop benchmark.

## Implementation sequence

All phases belong to this plan. Conditional experiments close with a written adopt/reject decision and supporting results; they are not silently deferred. Roles below identify responsibility, not staffing commitments. Each PR should update this document's evidence and acceptance status.

| Phase / owner | Concrete change and likely paths | Dependency and completion evidence |
| --- | --- | --- |
| 1. Baseline / performance owner | Versioned result schema and fixture manifest beside both benchmark scripts; real frame/tick metrics; actual device inventory; documented initial capacity workload. | First. Save reproducible JSON, raw samples, failures, and target-device runs. Calibrate budgets and noise; retain synchronous mode. |
| 2. Behavioral CI / test owner | Extend `tests/unit`, `tests/integration`, runner utilities, and `ci.yml` with serialized critical scenarios and separate coverage. | Use phase 1 scenarios. Required CI waits for the smoke lane; injected known defects fail; no silent skips. |
| 3. Real-time benchmark / client + server owners | Production `dist` test path through the owned runner; real WebSocket load driver; network impairment and browser lifecycle cases. | Phases 1–2. Measures update on touch devices, decode/apply, tick deadlines, actual connections, and generator utilization. |
| 4. Client improvements / rendering owner | Profile-led contour chunks, HUD invalidation, resize deduplication, bounded hot-path allocation, and optional quality tiers. | Phases 1–3. Same fixtures and visual checks pass; target phones meet budgets or show a reviewed quality-tier decision. Retain only measured wins. |
| 5. Server improvements / simulation owner | Monotonic scheduling/debt policy, collision-index experiment, tick-local views, complete outbound-pressure audit. | Phases 1–3; independent of most phase 4 edits. Clock and collision differential tests pass; capacity/soak evidence shows savings without state divergence. |
| 6. Protocol experiments / network owner | Current-capability encode/decode breakdown, cadence/interpolation experiment, compression comparison; evaluate binary and interest management only if earlier results justify them. | Phase 3 plus updated phase 4–5 baseline. Adopt/reject report includes CPU, bytes, memory, corrections, recovery, and compatibility. |
| 7. Operational acceptance / release owner | Aggregate production metrics, release-correlated dashboard, region/capacity report, admission limits, deploy/rollback rehearsal. Evaluate room routing if one world misses demand. | All accepted changes. Physical-device soak, supported-load soak, two-player deployment checks, and explicit worker/WebGL/replica decisions close the plan. |

The first PR should implement phase 1 without optimization. Its deliverable is an honest baseline that can reject a bad change. Phases 2–3 then make that evidence repeatable in automation. Avoid combining instrumentation, a new collision algorithm, and a protocol redesign in one PR because the source of either a gain or regression becomes difficult to establish.

### Commands available now

Run from `/Users/johnsolly/code/GeoRoids`, or substitute the absolute path of the implementation worktree. These are existing commands, not newly implemented tooling.

```sh
cd /Users/johnsolly/code/GeoRoids
npm run gate
npm run benchmark:game-loop
node --expose-gc --import tsx scripts/benchmark-snapshots.ts
./scripts/test-runner.sh tests/integration/server/mixed-version-pilots-recover-after-reconnect.test.ts
./scripts/test-runner.sh tests/integration/browser/sanity/mobile-viewport-fits-and-shows-touch-controls.test.ts
```

The full server/entity suite is `npm run test:all`; it does not include browser scenarios. Use `npm run test:integration:browser` for those. Run timed benchmarks separately from tests, builds, coverage, and other benchmarks. The integration runner owns its server processes and ports; use that ownership model for the proposed real-time benchmark instead of attaching to arbitrary local servers.

## Observability, rollout, and completion

Export bounded aggregate histograms every 15 seconds as an initial sampling policy, with measured instrumentation overhead below 1% of baseline CPU as the starting budget. Sample client sessions and expose supported/unsupported metrics explicitly. Use bounded labels for scenario, coarse device class, quality tier, region, and release. Correlation IDs belong in controlled diagnostic records, not high-cardinality metric labels.

Vercel Speed Insights can cover delivery and page responsiveness; custom gameplay measurements must cover sustained rendering and state application. Railway metrics and Node timing cover the server. Keep failed joins, disconnect reasons, resync counts, dropped diagnostics, and queue pressure alongside timings so a faster result cannot hide lost work.

Roll out one accepted optimization at a time. Client-only changes follow the Vercel Git deployment path. Server changes require a separate Railway deployment. For protocol changes, deploy the compatible server first, then the client offer, following [snapshot-v1 deployment rules](protocol/snapshot-v1.md#deployment-and-rollback). Verify both release IDs and two real players, including reconnect, before accepting the release.

Roll back on correctness regressions immediately. For performance, compare equivalent cohorts and workloads against the calibrated thresholds; retain the old implementation or release until the acceptance window closes. A client rollback may require reload/reconnect for already-open sessions. Restore the prior client offer before removing server support that active clients still require.

The plan is complete when critical behavior runs in required CI, benchmark reports reproduce with known noise, actual phones pass the selected quality budgets, the declared Railway workload passes sustained testing, and every architectural experiment has an evidence-backed decision. Publish supported device/load conditions and remaining measured limitations explicitly. A green build, low average CPU time, or healthy HTTP endpoint alone does not meet that bar.

## Sources

Repository evidence is pinned to `54d8c18d4ce25b3ea6af731582bd615666761a85`, with file links throughout. The historical snapshot measurements retain their original dates and limitations. External sources below are primary documentation accessed September 8, 2026; where no reliable publication date was shown, access date is the date reference. Platform limits and browser support should be rechecked during implementation.

1. Vite. [Performance](https://vite.dev/guide/performance). Development startup, transforms, and profiling.
2. Vercel. [Observability Insights](https://vercel.com/docs/observability/insights). Build, middleware, and edge delivery visibility.
3. Vercel. [Speed Insights metrics](https://vercel.com/docs/speed-insights/metrics). Web Vitals and page responsiveness targets.
4. MDN. [Window: requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame). Display scheduling and hidden-page behavior.
5. MDN. [JavaScript performance optimization](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Performance/JavaScript). Measurement, main-thread work, and execution cost.
6. Playwright. [Emulation](https://playwright.dev/docs/emulation). Viewport and device-property configuration.
7. Chrome for Developers. [Throttling](https://developer.chrome.com/docs/devtools/settings/throttling). Calibrated CPU approximations and network profile settings.
8. Playwright. [Assertions](https://playwright.dev/docs/test-assertions). Playwright Test retrying assertions and their scope.
9. Vitest. [Coverage](https://vitest.dev/guide/coverage.html). Optional V8/Istanbul providers and measurement implications.
10. MDN. [Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas). Repeated drawing caches and canvas-specific techniques.
11. MDN. [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas). Worker rendering and transfer mechanics.
12. Node.js. [Performance measurement APIs, Node 24](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html). Event-loop delay, utilization, and histograms. Version scoped to the repository's Node major.
13. MDN. [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket). Browser API backpressure limitation.
14. websockets/ws maintainers. [WebSocket compression](https://github.com/websockets/ws#websocket-compression). Compression defaults and CPU/memory caution.
15. Railway. [Optimize performance](https://docs.railway.com/deployments/optimize-performance). Regions, replicas, and lack of sticky sessions. Full text also available as [Markdown](https://docs.railway.com/deployments/optimize-performance.md).
16. Grafana Labs. [WebSockets in k6](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/). Recommended current load-testing API.

[^1]: Vite, [Performance](https://vite.dev/guide/performance), accessed September 8, 2026.
[^2]: Vercel, [Observability Insights](https://vercel.com/docs/observability/insights), accessed September 8, 2026.
[^3]: Vercel, [Speed Insights metrics](https://vercel.com/docs/speed-insights/metrics), accessed September 8, 2026.
[^4]: MDN, [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame), accessed September 8, 2026.
[^5]: MDN, [JavaScript performance optimization](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Performance/JavaScript), accessed September 8, 2026.
[^6]: Playwright, [Emulation](https://playwright.dev/docs/emulation), accessed September 8, 2026.
[^7]: Chrome for Developers, [Throttling](https://developer.chrome.com/docs/devtools/settings/throttling), accessed September 8, 2026.
[^8]: Playwright, [Assertions](https://playwright.dev/docs/test-assertions), accessed September 8, 2026.
[^9]: Vitest, [Coverage](https://vitest.dev/guide/coverage.html), accessed September 8, 2026.
[^10]: MDN, [Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas), accessed September 8, 2026.
[^11]: MDN, [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas), accessed September 8, 2026.
[^12]: Node.js, [Node 24 performance measurement APIs](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html), accessed September 8, 2026.
[^13]: MDN, [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), accessed September 8, 2026.
[^14]: websockets/ws, [WebSocket compression](https://github.com/websockets/ws#websocket-compression), accessed September 8, 2026.
[^15]: Railway, [Optimize performance](https://docs.railway.com/deployments/optimize-performance), accessed September 8, 2026.
[^16]: Grafana Labs, [WebSockets](https://grafana.com/docs/k6/latest/using-k6/protocols/websockets/), accessed September 8, 2026.
