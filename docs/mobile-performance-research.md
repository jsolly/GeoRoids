# GeoRoids mobile performance research

## Recommendation and evidence limits

Prioritize a repeatable mobile test path with constrained CPU and network conditions, then calibrate it against physical-phone sessions. Use that path to compare render resolution and glow effects while recording snapshot delivery and server timing. Keep Canvas 2D and the current single-world Railway architecture for this first round. The available evidence does not establish that a renderer rewrite, more Railway resources, or a different hosting provider would fix the reported slowdown.

Physical-device traces, sustained phone frame delivery, player-location RTT, and loaded Railway capacity remain unmeasured. No FPS improvement or supported player count is claimed here. The earlier performance work explicitly left those acceptance questions open. Its touch benchmarks used Chromium on an Apple M3, including 390×844 and 844×390 viewports. Small viewport CPU timings do not establish iPhone or Android performance.[^1]

The strongest first candidate is the main canvas backing resolution. It scales to the full device pixel ratio, unlike the title canvas, which caps its ratio at two. Glow effects, repeated contour traversal, and HUD text are the next candidates. These are code-supported hypotheses, ranked by how cheaply an experiment can distinguish them, rather than measured contributions to the slowdown.[^2]

The recommended order is:

1. Extend the production-client harness with explicit DPR, CPU, and network profiles; reproduce on the affected phone and classify rendering, input, network, and server delay separately.
2. Compare native resolution with effective DPR 2 and 1.5, then test reduced glow independently.
3. Optimize contour or HUD work only if phone traces attribute meaningful time to it.
4. Address network cadence, compression, region placement, or server execution only when correlated measurements identify those costs.
5. Require sustained device and multiplayer acceptance before calling the problem fixed.

This report assesses source revision `b4aec298e72840d026a2492902c5a4251d8d4e3c` and external documentation accessed September 10, 2026. Recommendations are proposed engineering work. No gameplay implementation or deployment accompanies this report.

## Current system and available evidence

### Rendering and input

`eventLoop.ts` updates and renders during each visible animation callback. `CanvasManager.drawGame` paints the background, stars, contours, contour laser effects, boundary, asteroids, loot, satellites, ships, projectiles, and HUD. The opaque context already uses `alpha: false`. Resize notifications are coalesced, unchanged backing dimensions are preserved, and visibility changes reset presentation time and request authoritative resynchronization.[^2]

The main canvas calculates backing dimensions as viewport dimensions multiplied by the browser's device pixel ratio. `contourRenderer.ts` walks all contour segments on each draw, projects endpoints, then rejects segments outside the viewport. It batches strokes by contour level. `contourLabels.ts` caches label anchors, but visible labels still perform text measurement and drawing. These distinctions matter: terrain generation and label placement are already cached; segment traversal and label rendering are separate costs.[^2]

Glow is distributed across ship hulls, lasers, shields, explosions, asteroids, boundary rendering, pickups, satellites, and other effects. A quality experiment must cover these sites consistently. Removing one glow constant and assuming all blur work disappeared would produce an ambiguous comparison.[^2]

Pointer controls and cancellation handling already exist in `src/input/touchControls.ts`. A complaint about unresponsive steering may arise from event scheduling, visual feedback, authoritative correction, or an interrupted gesture. It should not automatically trigger replacement of the touch controls.

### Authoritative server and protocol

The authoritative simulation runs at 60 Hz; periodic snapshots target 30 Hz. The server uses monotonic scheduling and bounds accumulated simulation debt. Broadcast state uses required snapshot-v1 keyframes and deltas, with per-recipient sequence and baseline state. A new canonical encoder is shared within one broadcast, but recipient encoding and JSON serialization still occur inside the recipient loop.[^3]

The broadcaster has a 256 KiB projected outbound limit, tracks pending sends, and requests a keyframe after skipped or failed delivery paths. Periodic keyframes use a 90-delta interval, approximately three seconds at an uninterrupted 30 Hz cadence. Recovery and skipped sends can alter that interval. These controls already exist and should be measured before changing them.[^3]

WebSocket compression is not enabled in the inspected server configuration. The existing optimization is JSON delta encoding. The historical protocol experiment measured standalone gzip and deflate codec work; it did not validate deployed per-message compression.[^4]

### What earlier measurements establish

The archived fixture contained ten entities and eighty asteroids, plus other world collections. Mean snapshot delta payload was 8,166.60 UTF-8 bytes, compared with 32,776.43 bytes for a keyframe. Its standalone deflate result for deltas was 1,289.99 bytes. These numbers demonstrate compressibility of that fixture, not real phone bandwidth, browser decode latency, or current production traffic.[^4]

The earlier spatial-grid collision candidate preserved tested outcomes but was slower than direct loops in every recorded fixture. Reintroducing that implementation would contradict the available experiment. A different spatial structure remains an option only if a larger measured workload makes collision traversal dominant.[^5]

Client measurements already separate frame intervals, update time, render submission time, and decode/application timing. These observations do not measure GPU completion or photons reaching the screen. The recorder has bounded retained samples, and historical touch sessions produced too few input observations to establish a latency distribution.[^1]

### Production observation

A single read-only observation at approximately 14:21 UTC on September 10 returned HTTP 200 from both deployment targets. The client header reported `b4aec298e72840d026a2492902c5a4251d8d4e3c`; Railway reported `3929da5874e65e4cb78b519221fbbb7f98fc2419`. The intervening commit consolidates browser tests, and the compared server, shared-protocol, and Railway paths have no changes. Different release strings therefore do not establish stale server behavior.[^6]

Railway health reported a paused world with zero human players and zero active world entities. There was no performance metrics block in that response. This is availability and release evidence only. It does not establish active-game tick timing, mobile RTT, or spare capacity. The September 9 inventory recorded one replica in `iad`; this report does not treat that historical configuration as a new authenticated platform inventory.[^6]

## Distinguishing the kinds of mobile slowdown

The client can animate its local ship while waiting for authoritative snapshots. The server can also produce healthy snapshots while the phone cannot render or apply them promptly. Measure both ends before changing either.

| Observable symptom | Leading hypotheses | Discriminating observation |
| --- | --- | --- |
| Local ship, HUD, and background all stutter | Main-thread work, raster cost, thermal pressure | Frame trace with update, render, and browser rendering activity; repeat at lower resolution |
| Local steering looks immediate but remote objects jump | Snapshot gaps, state application delay, presentation policy | Receive intervals and application timing while local frame cadence stays stable |
| All pilots hitch at the same moment | Server scheduling, broadcast work, shared connection path | Correlate multiple clients with server lateness and broadcast duration |
| Smooth initially, degraded after several minutes | Sustained resource demand, memory growth, changing scene | Fixed-scene repeated sessions, cooldown, memory and frame traces |
| Lag after backgrounding or changing networks | Suspension, reconnect, old queued state | Visibility and transport timeline through return to usable authoritative state |
| Long wait before Play becomes usable | Asset loading, initialization, connection/join | Separate cold load, terrain initialization, WebSocket open, and first playable frame |
| Steering stops while firing or after rotation | Pointer cancellation, capture loss, viewport mapping | Pointer lifecycle plus local input state and visual response |

Browser WebSocket does not provide inbound backpressure. A phone can fall behind processing messages even if the server's socket buffer appears acceptable. Application receive and apply timings are therefore necessary alongside server queue measurements.[^7]

Record RTT from an application ping and reply using the same monotonic client clock. Do not report `clientNow - serverTimestamp` as exact network latency without a clock-offset model. Receive-to-apply delay can be measured locally, but misses time spent in browser or transport queues before JavaScript receives the event. Server send completion likewise means acceptance by the transport path, not receipt or rendering on the phone.

## Canvas optimization choices

### Render resolution

For a 390×844 CSS-pixel viewport, the backing-store pixel count is `390 × 844 × effectiveDpr²`. The following figures are arithmetic estimates for one four-byte-per-pixel color buffer. They exclude browser copies, compositor surfaces, caches, and implementation-specific allocations.

| Effective DPR | Backing dimensions | Pixels | Approximate single-buffer MiB | Pixels relative to DPR 3 |
| --- | --- | ---: | ---: | ---: |
| 3 | 1170×2532 | 2,962,440 | 11.30 | 100% |
| 2 | 780×1688 | 1,316,640 | 5.02 | 44.4% |
| 1.5 | 585×1266 | 740,610 | 2.83 | 25.0% |
| 1 | 390×844 | 329,160 | 1.26 | 11.1% |

Moving from DPR 3 to 2 reduces backing pixels by 55.6%; moving to 1.5 reduces them by 75%. Neither percentage is an FPS prediction. JavaScript traversal, network work, and simulation can remain unchanged. The comparison tests whether pixel-dependent work is a substantial part of the phone's frame cost.

For the first implementation candidate, expose one effective rendering scale at the canvas boundary. Keep viewport dimensions, camera projection, world coordinates, and touch hit testing in CSS pixels. Update backing dimensions and the context transform together. Reusing backing-pixel dimensions in input conversion would change aiming or steering and invalidate the experiment.

Compare fixed tiers before introducing an automatic controller. DPR 2 is the recommended first candidate because it offers a large pixel reduction on DPR 3 phones with less sharpness loss than 1 or 1.5. Test thin contour lines, distant projectiles, names, HUD text, shields, and safe-area layouts in portrait and landscape. A slower or blurrier result is a reason to reject the candidate on that cohort.

If fixed tiers work, add conservative adaptation using sustained frame misses, a cooldown, and slower upgrades than downgrades. Do not resize every frame. Freeze adaptation during controlled benchmarks and record every tier transition in normal sessions. A whole-canvas scale is simpler initially; a separately rendered sharp HUD becomes justified only if text quality prevents adoption of an otherwise effective scale.

### Glow and visual density

MDN recommends avoiding expensive repeated canvas work, including unnecessary shadow blur and text drawing, and caching reusable imagery where appropriate.[^8] GeoRoids should test blur separately from geometry: keep hull strokes, projectile cores, shield boundaries, explosion timing, and danger signals visible while suppressing their glow. This distinguishes cosmetic blur cost from the cost of drawing the objects themselves.

A successful reduced-glow candidate should preserve faction recognition, collision cues, and projectile readability. Quality tiers must change presentation only. Reducing authoritative asteroids, collisions, projectile lifetime, damage checks, or network state to make a phone appear faster would change gameplay.

If blur dominates and the art requires it, compare bounded caches of reusable glow shapes with direct blur. Include cache construction, scaling, eviction, and memory in the measurements. Unique rotations, sizes, colors, and animated states can multiply cache variants. A small curated set is easier to reason about than caching every rendered object state.

### Contours and HUD

Contour drawing already rejects offscreen segments, but only after visiting and projecting their endpoints. If traversal dominates, build spatial chunks once per terrain revision and visit visible chunks. Compare this with cached `Path2D` chunks transformed by the camera. Path reuse can reduce JavaScript command construction; it does not eliminate rasterization of visible paths.

If rasterizing terrain dominates instead, compare bounded raster tiles. Define invalidation for terrain identity, zoom, effective DPR, and palette before adopting the cache. Inspect seams, label clipping, and sharpness during diagonal movement. A whole-world high-resolution bitmap is a poor default because its memory grows with world area and squared scale.

The first small HUD experiment is cached label width by text and font, since contour anchors are already cached. Then test static HUD geometry or leaderboard refresh on data changes. Keep health, fuel, ability availability, damage, and urgent warnings responsive. For a slower minimap refresh experiment, preserve or interpolate the local marker separately and verify that approaching threats remain legible.

Do not change all rendering layers at once. A lower-DPR comparison, a blur comparison, and a contour comparison should each report independent results. Once individual effects are understood, test the combined candidate because improvements need not add linearly.

### Animation cadence and canvas options

Animation callbacks generally follow display refresh, which may exceed 60 Hz. Background callbacks are usually paused. GeoRoids already uses callback timestamps and has visibility recovery; the remaining question is whether high-refresh phones spend unnecessary work rendering every callback.[^9]

Measure 60 Hz presentation on 90/120 Hz devices before offering a 30 Hz battery-saving tier. Treat this as a separate experiment from rendering scale. At 60 Hz there is about 16.67 ms between refresh opportunities; at 120 Hz about 8.33 ms. A limiter must use elapsed time and preserve simulation/input semantics rather than assuming every callback represents a fixed 60 Hz tick. Since update and render currently share the callback, a naive early return would throttle both.

Keep the existing opaque context. `willReadFrequently` is intended for frequent pixel readback and can select software rendering; it is not a general acceleration option. `desynchronized` is a latency hint that needs a fresh context experiment, compatibility checks, and visual review. Calling `getContext` again does not create a new context with new settings.[^10]

### OffscreenCanvas and WebGL

OffscreenCanvas can move canvas work into a worker, and Safari added 2D OffscreenCanvas support in 16.4. That historical support milestone does not prove every required worker, font, lifecycle, and context feature on the project's supported phones.[^11][^12]

Use a worker prototype only when main-thread contention remains after simpler changes. GeoRoids' renderer reaches through canvas and manager singletons, so worker rendering requires an explicit rendering input representation, ownership of resources, and a bounded message handoff. Measure serialization or transfer cost and state freshness. Moving work can improve responsiveness without reducing total pixel cost or energy demand.

Consider a WebGL renderer when traces show that the required scene remains too expensive in Canvas 2D. The prototype should cover actual contours, glow, labels, ships, particles, and context loss rather than a synthetic sprite count. WebGL still needs batching, memory budgeting, and appropriate backing resolution.[^13] Require an end-to-end phone advantage large enough to justify replacing drawing code and visual tests. A technology migration is not the first experiment.

## Networking and Railway

### Payload and cadence

Using the archived delta fixture as an illustration, `8,166.60 × 30 × 8` is about 1.96 Mbit/s per recipient before keyframes, events, WebSocket framing, TLS, or TCP overhead. The arithmetic shows why payload measurement matters on cellular links. It is not a production traffic estimate: actual world contents and change density determine bytes.[^4]

Measure payload distributions by message kind and actual delivery rate. Record large keyframes and repeated recovery separately from normal deltas. A client that continually recovers may use more bytes and feel worse despite the presence of delta encoding.

If transmission or application load is dominant, compare 30 Hz with 20 Hz snapshots in an isolated candidate while keeping the authoritative simulation at 60 Hz. Twenty Hz changes the nominal update interval from 33.3 to 50 ms. Lower frequency may create larger deltas, and remote motion may need different presentation buffering, so neither byte savings nor smoothness follows automatically. Measure corrections, shot feedback, asteroid motion, and delivery gaps as well as bandwidth.

A phone-specific cadence needs an explicit protocol/configuration design and tests for divergent recipient baselines. An interpolation policy adds visual delay to tolerate jitter. Tune it against measured gaps and gameplay cues; do not hide a growing queue behind an ever-longer buffer. Audit the existing entity-specific prediction and synchronization paths before adding another smoothing layer.

### Backpressure and recovery

The current 256 KiB limit is a memory guard, not a freshness target. At an illustrative 1 Mbit/s drain rate, 256 KiB represents roughly 2.10 seconds of bytes. That calculation does not mean every current socket queues that amount; pending-send handling also limits production behavior. It demonstrates why a byte threshold alone cannot certify responsiveness.

A congestion experiment should correlate queue size, pending duration, snapshot gaps, recovery keyframes, and time until the client applies current state. Consider a freshness-oriented policy only if the trace shows stale work accumulating. Preserve the distinction between replaceable world presentation and reliable gameplay events.

Never discard arbitrary deltas and then apply a later dependent delta. Recovery must establish a valid baseline, or the client must continue decoding the chain before choosing which complete state to present. If a worker decodes messages, give its queue an explicit bound and recovery path. Otherwise the worker merely relocates the backlog.

### Compression

The `ws` project documents CPU and memory costs for per-message deflate and warns about Linux memory fragmentation under concurrency.[^14] The archived zlib experiment is a reason to run a controlled test, not to enable compression by default.

Test negotiated compression on the actual Linux deployment shape with representative recipients, differing baselines, impaired readers, and reconnects. Record wire bytes where observable, Node RSS, CPU, event-loop delay, broadcast duration, phone receive/apply cost, and state freshness. Browser decompression can occur before the JavaScript message callback, so callback timing alone misses part of the work. Inspect negotiated extensions and compare complete sessions.

Keep compression disabled unless the measured reduction in delivery delay or data use outweighs CPU, memory, and recovery costs. Include concurrency limits, context-takeover choices, and compression thresholds in the candidate definition. Avoid changing compression, cadence, and encoding simultaneously.

### Server execution and placement

Railway provides service resource metrics, but application latency and error metrics need application instrumentation. Node's performance APIs expose event-loop delay and utilization; GeoRoids already has opt-in process diagnostics built on this class of measurements.[^15][^16] Use tick lateness, execution duration, catch-up/discarded debt, broadcast time, GC pauses, outbound outcomes, and client delivery together.

Average CPU across a service does not show whether the JavaScript game loop met a particular 16.67 ms deadline. Increasing the permitted CPU allocation does not itself parallelize the current loop. If profiles identify per-recipient serialization as the limiting work, examine shared output for equivalent baselines and allocation costs first. Preserve distinct output where recipients have different baseline or recovery state.

Choose regions from measured player RTT and jitter. Railway currently documents US West, US East, EU West, and Southeast Asia deployment locations.[^17] The earlier `iad` inventory should be reconciled with actual account configuration before any region change; do not blindly substitute a newer documented identifier. A healthy connection from a development Mac is insufficient evidence for a mobile player's region.

Vercel serves the static client; the active game socket points directly to Railway. Improving static asset caching can improve loading, but does not remove the ongoing mobile-to-game-server path. Separate cold-start investigation from in-game frame and state-delivery work.

### Replicas and world ownership

Railway load-balances new connections across replicas and documents no sticky-session support.[^18] A connected WebSocket stays with its accepting process, but a reconnect is a new routing decision. GeoRoids stores authoritative world state and resume information in process memory. Adding identical replicas therefore creates separate worlds; it does not divide one world safely across CPUs.

If measured demand requires horizontal scaling, first implement explicit room ownership, room-aware connection routing, reconnect routing, admission limits, and world failure behavior. Region selection must keep players intending to meet in the same room together. A shared directory can locate a room owner; it does not make the simulation itself shared. This is a larger capacity feature with its own correctness acceptance.

Railway documentation is inconsistent about replica metrics: the dedicated Metrics page describes Sum and Replica views, while Scaling still says replica metrics are unavailable. Prefer the dedicated observability page for the described capability and verify the actual account UI before depending on it. This discrepancy does not alter the documented absence of sticky sessions.[^15][^18]

## Measurement and acceptance plan

### A constrained mobile regression path

The existing realtime client runner hard-codes `deviceScaleFactor: 1` and offers no CPU or network profile options. The load runner separately supports ordered TCP impairment. These are useful components, but they do not yet test an actual browser rendering at phone-like DPR while receiving constrained state delivery. The runner also bakes a direct server WebSocket endpoint into its production build, so merely starting a proxy would not exercise it.[^22]

Extend the existing runner rather than creating a separate gameplay test application. Keep a clean control, CPU-only constraint, network-only constraint, and combined constraint. Use 390×844 and 844×390 viewports at DPR 3 to expose backing-resolution work, plus DPR 1 as a diagnostic comparison. Device DPR and the game's proposed effective rendering scale must be recorded separately.

For Chromium, a 4× CPU slowdown is a reasonable initial stress parameter; 6× can be an additional severe lane. Chrome DevTools Protocol defines these as slowdown factors, not named phone models.[^23] A throttled desktop CPU still has desktop GPU, memory, browser, and thermal behavior. Do not claim that a 4× run emulates a particular iPhone or that a lower reported hardware-concurrency value restricts actual resources.

Reuse the proxy's current normal and degraded profiles for browser gameplay. Normal configures 40 ms chunk delay with ±20 ms jitter and 625,000/125,000 bytes per second down/up. Degraded configures 90 ms with ±60 ms jitter and 125,000/32,000 bytes per second. Delay is applied per ordered chunk, so report measured RTT and throughput; those settings are not exact one-way latency or a standardized cellular class. The clean load mode bypasses the proxy.[^22]

Ensure the browser's real `/ws` connection goes through the selected proxy by configuring the test endpoint before the production build or through an owned routing layer. Confirm it with observed proxy traffic and an application RTT/throughput witness. Keep health collection direct for attribution and label that distinction. Chrome DevTools also supports WebSocket throttling, contrary to older advice that it affects only HTTP. It is useful for manual triage, but the repository proxy provides one common impairment mechanism for browser and load experiments.[^24]

CPU throttling does not supply a faithful phone memory limit. Track browser memory where available, cap application caches, and use a separate memory-pressure robustness experiment on an isolated runner if needed. A V8 heap limit is not a total browser-memory cap. For Railway capacity, resource-constrain a separate server process or container rather than slowing the browser and server together. Record load-generator headroom so its saturation does not masquerade as a server defect.

Run a short constrained gameplay scenario on PRs for correctness and severe regressions. Use repeated longer comparisons on a stable runner for performance thresholds, and physical devices for sustained GPU/thermal acceptance. Initially publish timing results without claiming calibrated FPS guarantees; make timing gates mandatory only after baseline variation is bounded. The [runbook](performance/mobile-measurement-runbook.md#constrained-browser-path-to-implement) defines the implementation and fail-closed checks.

### Device and workload coverage

Start with the phone that exhibits the slowdown. Add one older supported iPhone, a midrange Android, and a high-refresh phone as available. Record the actual model, OS/browser versions, CSS viewport, device DPR, effective DPR, display mode, battery-saving state, and whether the device is charging. These are test cohorts, not a purchasing recommendation or a declared support matrix.

Use real Android remote debugging and Safari Web Inspector on a physical iPhone. Chrome's device mode is an approximation, and desktop WebKit is not iPhone hardware.[^19][^20] Disable Android screencasting during frame measurements because it affects frame rate. Use short diagnostic traces and separate longer acceptance runs with minimal instrumentation. WebKit's timelines expose JavaScript and rendering activity for attribution.[^21]

Begin with three repeated baseline sessions, then alternate baseline and candidate order. Cool the phone to a comparable starting condition, use comparable brightness and power settings, and distinguish charging from unplugged runs. Record warmup separately. Use five minutes of sustained play for the initial comparison and at least fifteen minutes for the candidate's sustained-behavior check. These durations are proposed experimental controls, not published guarantees.

Cover quiet traversal, dense contours, thrust plus continuous fire, asteroid destruction and fragments, multiple visible pilots, satellite/pickup activity, death/respawn, rotation, background/return, and Wi-Fi/cellular transition. Keep seed, counts, and meaningful game outcomes comparable. Do not compare a busy baseline with a candidate that happens to spend longer in a menu or empty world.

### Measurements and proposed budgets

These budgets are initial engineering targets for calibration on supported devices. They are not existing product guarantees. Report per-device sessions and their spread; do not pool all frames across different phones into a single percentile.

| Dimension | Initial target or decision rule | Required qualification |
| --- | --- | --- |
| 60 Hz foreground presentation | Fewer than 1% intervals above 25 ms; p99 near or below 33.3 ms | Scheduling proxy; correlate with browser frame evidence and visible stutter |
| 30 Hz optional tier | Fewer than 1% intervals above 50 ms | Assess touch feel explicitly; do not call it equivalent to 60 Hz |
| Client CPU submission | p95 below 10 ms for a 60 Hz tier | Leaves headroom but does not prove raster/display completion |
| Input response | Handler-to-render p95 below 33.3 ms, with hundreds of distinct inputs | Excludes hardware-to-handler and display latency |
| Server deadlines | p99 tick execution below 16.67 ms; no sustained simulation debt | Include broadcast and scheduling interference, not tick duration alone |
| State delivery | Track actual rate and full gap distribution; no growing state age | Existing load-driver checks of 27 states/s and 250 ms maximum gap are diagnostic defaults |
| Sustained behavior | No growing memory trend or repeated late-session collapse | Compare early and late matched workload windows |
| Correctness | No lost controls, divergent state, broken recovery, or missing danger cues | Performance improvement cannot compensate for incorrect gameplay |

For input, repeated changes of direction and separate presses provide samples that a continuously held touch does not. For energy, use matched unplugged runs with fixed display settings and OS tooling where available. Battery percentage is coarse; report session duration and conditions, and avoid converting a short trace into an hours-of-battery-life promise.

Drain bounded metric recorders often enough to avoid silently dropping samples. Report omissions, frame failures, disconnects, menu time, respawn time, and unanswered probes. Existing 15-second aggregate windows must not be summed from overlapping health polls. Run instrumentation-on/off comparisons so the measurement overhead does not become the bottleneck.[^1]

### Experiment decisions

| Priority | Candidate | Evidence that justifies adoption | Reason to reject or change direction |
| --- | --- | --- | --- |
| 1 | Effective DPR 2, then 1.5 | Repeatable tail-frame improvement with readable gameplay | CPU/network dominates or unacceptable loss of sharpness |
| 2 | Reduced glow | Lower render/raster cost with preserved cues | No measurable benefit or ambiguous projectiles/shields |
| 3 | Contour chunks or reusable paths | Profiled traversal cost drops across terrain scenes | Cache cost, seams, or memory outweigh savings |
| 4 | Cached label widths and selective HUD updates | Reduced measured text/HUD cost | Stale urgent information or negligible contribution |
| 5 | 60 Hz presentation cap on high-refresh devices | Better sustained behavior with acceptable input response | Incorrect timing or visible cadence artifacts |
| Conditional | Lower snapshot cadence or compression | Better freshness/data use under measured constraint | More corrections, CPU pressure, or longer recovery |
| Conditional | Server hot-path or region adjustment | Correlated server lateness or geographic RTT evidence | Phone rendering remains the limiting stage |
| Escalation | Worker/WebGL renderer or room scaling | Simpler candidates fail a defined supported-device/load target | Added architecture lacks a demonstrated end-to-end advantage |

Do not apply every row. Each conditional candidate has an evidence gate; rejecting an ineffective experiment is a completed decision. Keep raw results and the reason for adoption or rejection with the relevant revision.

## Delivery sequence and verification

The first implementation change should connect DPR, CPU throttling, and ordered network impairment to the existing production-client runner and prove that each constraint actually applies. Add missing attribution counters and the controlled rendering-scale comparison next. Follow with the smallest successful rendering change. Add a production quality policy only after fixed settings prove useful on real phones. Remove temporary switches and unused experiment paths once decisions are made.

Server or protocol work follows the measurements, with client and server changes coordinated when necessary. Preserve snapshot-v1 recovery and authoritative asteroid and projectile behavior. Any accepted quality setting or changed user-visible behavior needs corresponding Wiki controls, behavior, and troubleshooting updates with source-review verification. This research-only addition changes no Wiki behavior.

Run the focused canvas/input/protocol tests appropriate to each implementation, then the repository gate. Integration and browser scenarios must use the repository runner. Include simultaneous steering/fire, ability/shield feedback, rotation, death/respawn, background recovery, and two-player reconnect. Visual checks must cover low-quality rendering as well as the normal tier.

Ship through the branch, PR, and CI-gated merge flow. Client changes use Vercel Git deployment. Server changes require the separate Railway deployment and must preserve unrelated staged configuration. Verify release ancestry through both relevant `x-release-id` headers, then run two-player and reconnect smoke before repeating mobile acceptance. An HTTP 200 response alone does not prove a performance change reached production.

The companion [measurement runbook](performance/mobile-measurement-runbook.md) specifies executable repository checks, device evidence, and the experiment record. Existing [performance strategy](performance-and-testing-strategy.md) and [benchmark guide](../benchmarks/README.md) remain the references for broader capacity and harness semantics.

## Sources

Footnotes below provide the source inventory. Living documentation was accessed September 10, 2026; publication dates are identified only where established. Repository observations refer to the source revision stated above. Historical benchmark documents retain their original revision and workload limitations.

[^1]: GeoRoids. [Performance implementation status](performance/implementation-status.md), September 9, 2026 historical receipts; [benchmark framework](../benchmarks/README.md), inspected September 10, 2026. Existing measurement coverage, sample limits, physical-device gaps, and diagnostic workload thresholds.
[^2]: GeoRoids source. [Canvas manager](../src/rendering/canvas.ts), [event loop](../src/core/eventLoop.ts), [title terrain](../src/rendering/titleTerrain.ts), [contour renderer](../src/rendering/contourRenderer.ts), [contour labels](../src/rendering/contourLabels.ts), [ship renderer](../src/entities/ship/shipRenderer.ts), [asteroid renderer](../src/entities/roid/roidRenderer.ts), and [touch controls](../src/input/touchControls.ts). Inspected at `b4aec298e72840d026a2492902c5a4251d8d4e3c`.
[^3]: GeoRoids source. [Game engine](../server/core/GameEngine.ts), [broadcaster](../server/services/GameStateBroadcaster.ts), [snapshot constants](../shared/snapshotProtocol.ts), and [server creation](../server/createServer.ts). Inspected at `b4aec298e72840d026a2492902c5a4251d8d4e3c`. Scheduling, protocol, and queue behavior.
[^4]: GeoRoids. [Protocol and compression experiment](performance/protocol-experiment.md), September 9, 2026. Archived fixture measurements, codec-only compression results, and limitations.
[^5]: GeoRoids. [Circle collision index experiment](performance/collision-experiment.md), September 9, 2026. Correctness comparisons and rejected candidate timings.
[^6]: GeoRoids. [Production HTTP observation](performance/mobile-research-production-observation-2026-09-10.json), September 10, 2026, 14:21 UTC; [previous Railway inventory](performance/production-inventory-2026-09-09.json), September 9, 2026. Original endpoints: [client](https://www.georoids.com) and [server health](https://geoasteroids-production-2403.up.railway.app/health). Local Git comparison of the observed server release against the assessed revision established the test-only difference.
[^7]: MDN contributors. [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket). Living API reference, accessed September 10, 2026. Browser inbound backpressure limitation.
[^8]: MDN contributors. [Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas), last modified August 25, 2026. Reusable drawing work, text, shadow blur, and canvas batching guidance.
[^9]: MDN contributors. [Window: requestAnimationFrame()](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame). Living API reference, accessed September 10, 2026. Display cadence, callback timestamps, and background behavior.
[^10]: MDN contributors. [HTMLCanvasElement: getContext()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/getContext). Living API reference, accessed September 10, 2026. Context creation, opacity, desynchronization, and readback hints.
[^11]: MDN contributors. [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas). Living API reference, accessed September 10, 2026. Worker rendering and transferable canvas support.
[^12]: WebKit. [WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), March 27, 2023. Historical addition of 2D OffscreenCanvas support.
[^13]: MDN contributors. [WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices). Living guidance, accessed September 10, 2026. Batching, resource limits, and smaller backing buffers.
[^14]: websockets/ws maintainers. [ws README, WebSocket compression](https://github.com/websockets/ws/blob/master/README.md#websocket-compression). Upstream documentation, accessed September 10, 2026. Negotiation, compression options, CPU/memory overhead, and Linux concurrency warning.
[^15]: Railway. [Metrics](https://docs.railway.com/observability/metrics). Living platform documentation, accessed September 10, 2026. Resource metrics, application instrumentation limits, Sum and Replica views.
[^16]: Node.js project. [Performance measurement APIs, Node 24](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html). Version-family documentation, accessed September 10, 2026. Event-loop delay and utilization; Node 24 matches the repository's required major version.
[^17]: Railway. [Regions](https://docs.railway.com/deployments/regions). Living platform documentation, accessed September 10, 2026. Current documented locations and identifiers.
[^18]: Railway. [Scaling](https://docs.railway.com/deployments/scaling). Living platform documentation, accessed September 10, 2026. Replica routing, resource allocation, and lack of sticky sessions; replica-metrics wording conflicts with the dedicated Metrics page.
[^19]: Kayce Basques and Sofia Emelianova, Google. [Remote debug Android devices](https://developer.chrome.com/docs/devtools/remote-debugging/). Living Chrome DevTools guide, accessed September 10, 2026. Physical-device debugging and screencast measurement impact.
[^20]: Google. [Simulate mobile devices with Device Mode](https://developer.chrome.com/docs/devtools/device-mode). Living Chrome DevTools guide, accessed September 10, 2026. Limits of desktop device emulation.
[^21]: WebKit. [Timelines Tab](https://webkit.org/web-inspector/timelines-tab/). Web Inspector reference, accessed September 10, 2026. JavaScript and rendering timeline attribution.
[^22]: GeoRoids source. [Realtime client runner](../benchmarks/realtime-client.ts), [load runner](../benchmarks/load.ts), [ordered TCP proxy](../benchmarks/tcp-proxy.ts), and [test runner](../scripts/test-runner.sh). Inspected at `b4aec298e72840d026a2492902c5a4251d8d4e3c`. DPR 1, separate impairment path, exact profile parameters, and build-time endpoint selection.
[^23]: Chromium project. [Chrome DevTools Protocol: Emulation.setCPUThrottlingRate](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate). Living protocol documentation, accessed September 10, 2026. CPU slowdown-factor semantics; verify support against the pinned browser version.
[^24]: Google. [Network features reference: throttle WebSocket connections](https://developer.chrome.com/docs/devtools/network/reference#throttle-websocket-connections). Living DevTools documentation, accessed September 10, 2026. WebSocket throttling since Chrome 99 and manual verification procedure.
