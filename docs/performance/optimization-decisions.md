# Performance plan relevance and optimization decisions

The table below records the earlier strategy review, not a current performance
ceiling. The [mobile implementation report](mobile-implementation-status.md)
collects the subsequent decisions and measured renderer, collision and snapshot
changes. The [current compression comparison](current-compression-results.md)
rejects both tested levels after their server CPU increases exceeded the fixed
limit. Missing profiling evidence does not disprove every alternative.

The [current MessagePack screen](current-binary-codec-results.md) rejects its
tested configuration: the 14–15% raw-byte saving comes with 11.6–15.3% more complete
codec CPU, beyond the fixed limit. The earlier
[offline trial](binary-codec-results.md) remains historical evidence.

The recorded benchmark receipts below predate legacy-client retirement. Current
load sessions use the required snapshot protocol for every pilot; old mixed-client
measurements remain historical evidence only.

The complete [performance strategy](../performance-and-testing-strategy.md) has
been checked against the current code, its historical source revision, the local
experiments, and independent client and server reviews. The current implementation
includes main through `a83028a`, including the direct gameplay controls.
[Implementation status](implementation-status.md) records validation
and acceptance gaps separately.

The engineering recommendation is to stop adding optimizations without a measured
bottleneck. This is not a universal performance ceiling: actual phone performance,
deployed capacity, instrumentation overhead and long-session memory remain
unverified. Those missing measurements do not establish a benefit for a cache,
pool, renderer rewrite or protocol change.

The [current contour query experiment](contour-query-cache-results.md) supersedes
the historical cache disposition for that one measured function. A bounded
last-query cache now has repeated timing and exact rendering evidence.

The [collision work](asteroid-collision-work-results.md),
[snapshot serialization](snapshot-json-reuse-results.md), and
[validator preparation](snapshot-validation-results.md) reports likewise replace
the historical no-bottleneck conclusions for those measured paths. Their phase
gains do not establish phone or deployed capacity acceptance.

## Historical disposition of the opportunities

| Opportunity | Decision and evidence |
| --- | --- |
| Cold/warm startup and join | Join-to-authoritative-render timing and explicit failure settlement are implemented in `src/diagnostics/performanceMetrics.ts` and `ConnectionManager`. The native client run records initial joins and natural game-over rejoins; its [receipt](implementation-status.md#verification-receipts) is not a controlled cold/warm page-cache cohort or proof of the proposed two-second phone/network budget. No bundle-loading redesign is justified by the current evidence. |
| Local input feedback | Keep the existing local prediction and direct controls. Opt-in event-handler-to-render samples are collected during trusted keyboard/touch workloads; [client results](implementation-status.md#verification-receipts) report their bounded scope. They exclude hardware latency and scanout. The proposed 50 ms phone budget and physical feel remain unverified; no input architecture change is justified by the desktop-hosted emulation alone. |
| Contour traversal and spatial chunks | Retain the existing level batching and segment culling in `src/rendering/contourRenderer.ts`. Chunks add bounds, ordering and edge-continuity responsibilities; no current subphase profile shows that traversal dominates. |
| Repeated geometry and decoration caches | Retain existing terrain/contour-label caches. Reject additional caches without a measured repeated cost; their viewport, scale, palette and entity invalidation must be justified by a benefit. |
| Leaderboard ordering and name layout | Retain the small-player-list path in `src/rendering/hud/leaderboard.ts`. Sorting and repeated text measurement remain visible candidates, but no measured result warrants adding a membership/score/font/width cache. |
| Minimap refresh | Retain current updates and the reusable projection object in `src/rendering/hud/minimap.ts`. A slower refresh changes what players see and requires interpolation; there is no demonstrated cost warranting that change. |
| HUD environment reads | Do not add an event-only cache. `hudLayoutForCanvas` reads safe-area styles and pointer media each draw; the plan's contrary historical claim was corrected after checking both revisions. The existing safe-area browser scenario requires an immediate style change to affect the next draw. Any cache must retain that behavior and demonstrate worthwhile savings. |
| Canvas backing dimensions | Implemented coalescing and unchanged-dimension protection in `src/rendering/canvas.ts`. The existing effective DPR of one is retained; a second generic DPR cap would duplicate it. The pixel-preservation regression test rejects unnecessary bitmap resets. |
| Reduced effects, render scale, 30 Hz quality tier | Reject adoption without phone raster/thermal evidence. These alter visible quality and need a measured device budget; the simulation and combat cadence must remain unchanged. |
| Hidden-page recovery | Implemented input release, presentation-clock reset and authoritative resync. Reconciliation preserves direct-control gesture cancellation and disabled-snapshot pilot clearing. Held-input and clock-mutation scenarios protect these rules. |
| Client pools and harpoon-field reuse | Reject adoption without allocation evidence. The harpoon path creates temporary views, but movement replaces position objects; storing references or reusing rows changes ownership requirements. A pool is not justified by allocation syntax alone. |
| OffscreenCanvas and WebGL | Reject adoption. The current renderer depends on managers, DOM layout and effects; a transfer boundary, fallback and new renderer would add substantial complexity without a demonstrated bottleneck. |
| Monotonic clock and bounded debt | Implemented. Scheduling uses a monotonic clock, excess simulation debt beyond one second is counted and discarded, and simulated entity motion receives the actual simulation-frame delta. Wall-clock reconnect grace retains its meaning. Controlled defects confirmed that repeated debt replay fails the regression tests. |
| Collision index | Reject the tested grid. All 800 seeded worlds preserved outcomes, but the grid was 12.9–342.5 times slower. The [circle experiment](collision-experiment.md) excludes swept projectiles; no projectile-index claim is made. |
| AI searches and tick-local views | Retain current entity-array ownership. The [loaded server profiles](loaded-server-profile.md) attribute only 0.023–0.034% of estimated allocation to `EntityManager.getAllEntities`. No live-array cache is justified by this ten-pilot load. Unrepresented AI/world shapes remain outside that observation. |
| Per-player snapshot filtering | Retain local visibility and private recipient ownership. Generic interest helpers each use less than 0.25% of sampled wall time in the [loaded profiles](loaded-server-profile.md); snapshot capture/copy/diff and specific loot-query work are larger targets for separate experiments. No broad filtering rewrite is justified. |
| Outbound pressure | Implemented a bounded policy for every gameplay class, including snapshots and gameplay events. Snapshot pressure requires recoverable keyframes; nonrecoverable or permanently oversized writes close explicitly. Enhanced resume tokens survive pressure closure and event-write failure. Metrics distinguish queued acceptance from delivery, which the real clients validate separately. |
| Existing JSON deltas | Retain them. The [Unicode protocol experiment](protocol-experiment.md) validates round trips and shows 75.04% fewer application bytes than full legacy JSON in its fixture. Shared canonical preparation and negotiated recovery already exist. |
| Lower snapshot cadence | Reject adoption without correction-distance, interpolation and response measurements. A lower rate changes visible motion and recovery; a smaller byte count alone cannot validate it. Simulation stays at 60 Hz and snapshots at 30 Hz. |
| Compression | Keep production compression disabled. The isolated gzip/deflate experiment reports bytes and CPU but does not establish concurrent WebSocket memory or end-to-end latency. Its smaller payloads are insufficient evidence to enable the feature. |
| Binary protocol and interest management | Reject adoption. There is no demonstrated end-to-end bottleneck requiring a new wire format or visibility contract. Interest management must preserve offscreen combat, HUD completeness and recovery semantics. |
| Extra replicas and room routing | Retain one authoritative process per world. Additional replicas need explicit world placement and reconnect routing. With no users and no demonstrated capacity shortfall, those systems would add complexity without an established benefit. |
| Region and admission reserve | No production configuration change. The read-only Railway inventory records one `iad` replica and an existing staged operation. Local loopback timing cannot choose a player-facing region or justify an admission limit. |
| Player ceiling | Retain `MAX_PLAYERS=100` as a provisional hard admission ceiling, without a human-concurrency certification. In the [local worker-persistence staircase](loaded-server-profile.md#local-capacity-observation-and-its-cause), 10 pilots met delivery references and 25 delivered about 15.3 states/s with a fully busy server event loop. That is a local throughput concern, not sufficient evidence for a replacement production cap. |
| Aggregate diagnostics | Implemented bounded opt-in client samples and server histograms, GC, event-loop, memory and outbound observations. Keep them opt-in until overhead is calibrated. Coalesced pending snapshots and send-completion latency are not separately attributed; actual state gaps remain in load reports. |
| Developer/test performance | Retain the repository-owned serialized integration runner and existing static gate. Required smoke dependency, scheduled full integration and separate coverage are implemented. Do not add integration workers or migrate test runners without measured maintenance benefit and isolation proof. |
| Baseline calibration and regression gating | Keep raw samples, failures, workload witnesses and input hashes. No numeric performance CI threshold or supported-device claim is enabled without unchanged-control noise measurements and target-device calibration. |
| Field dashboards, soaks and rollout | Not accepted by local tests. Physical-device runs, remote workload staircases, 30-minute boundary soaks, two-player deployment verification remain release-acceptance work. No deployment or remote load was performed. |

## Evidence and limits

The [2026-11-12 loaded-server follow-up](loaded-server-profile.md) captures four
CPU/allocation profiles, two unprofiled ten-pilot observations and bounded 10/25
worker-persistence steps on clean source `b741509c`. It settles the live-array,
recipient-filtering and player-ceiling code decisions above. Its synthetic
80-initial-rock scenes include both ordinary destruction/fragmentation and a
declared metal/endurance companion. They do not certify human or production
capacity. The measurements below remain historical evidence from their recorded
revision.

The five-pilot loopback workload (one legacy, four negotiated) completed 30 seconds
of warmup and 180 seconds of measurement. All five pilots completed, delivering
26,405 states, about 29.34 states/second per pilot. All 180 measured RTT probes
were answered. Each negotiated pilot observed authoritative projectiles born
after its measured input acknowledgment. The driver also exercised natural
game-over rejoins and six deliberate periodic resyncs per negotiated pilot.

The default evolving world starts with 20 asteroids; this is not
the proposed 10-human/80-asteroid loaded battle. State-gap maxima were 151–170 ms.
After-warmup full metric windows had tick p99 bucket bounds no higher than 4 ms
and broadcast p99 bounds no higher than 8 ms, but isolated maxima reached about
116 ms and 128 ms. No simulation debt was discarded and no attempted send failed
or was closed/skipped for pressure. Overlapping health snapshots must not be
summed as independent windows. These observations do not establish Railway
capacity, leak freedom or a mobile network budget.

Raw evidence is `.performance/load-completion-audit.json` and its sibling log.
It predates the client-only direct-controls merge; server and shared simulation
sources were unchanged by that merge. The first sustained client report is
preserved as failed: it exposed an invalid initial CDP touch cancellation and
intentional game-over disconnects classified as warnings. The corrected touch
lifecycle then passed 60 seconds and two natural rejoins with no browser errors
or warnings. Final sustained client results are recorded in implementation status.

The original independent review found no demonstrated additional optimization to
adopt and identified target-phone work and a loaded server profile as useful
measurement questions. The loaded profile is now recorded above. It demonstrates
substantial broadcast allocation and a local state-rate boundary, but does not
demonstrate a benefit from the proposed live-array cache or broad filtering
rewrite. Target-phone HUD/terrain/harpoon cost remains a separate question.
