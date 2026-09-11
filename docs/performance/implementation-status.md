# Performance implementation status

The recorded benchmark receipts below predate legacy-client retirement. Current
load sessions use the required snapshot protocol for every pilot; old mixed-client
measurements remain historical evidence only.

Physical Android/iPhone runs, calibrated mobile budgets,
instrumentation overhead, deployed capacity/soaks, and release acceptance
have not been established. No supported player count or mobile frame-rate claim
follows from these local checks.

All seven plan areas have been assessed against the codebase on September 9, 2026. The implemented
changes address observed correctness and measurement gaps. Further caching,
pooling, rendering architecture, spatial indexing and protocol changes lack
evidence of a worthwhile benefit here; the measured grid candidate was slower.
This is an engineering stopping point, not proof of a measured performance
ceiling on physical devices or the deployed service. The complete opportunity
inventory and reasons for stopping are in [optimization decisions](optimization-decisions.md).

At the time of these local validation receipts, the changes had not been pushed
or deployed. This record does not certify a production release; deployment proof
belongs to the shipping receipt. The gameplay-control cleanup is reconciled:
direct controls, gesture cancellation and
disabled-snapshot pilot clearing are preserved. The combined gameplay and Wiki
checks passed. No additional optimization architecture is proposed.

This branch includes main through `a83028a`, including the refactoring,
pinned-revision benchmark framework and direct controls. The work stays in
`/Users/johnsolly/.codex/worktrees/georoids-performance` on
`perf/measurement-and-runtime`.

| Phase | Implemented or investigated | Remaining acceptance work |
| --- | --- | --- |
| 1. Baseline | Shared measurement schema; pinned diagnostic harness on main; real client and server timing; release and environment metadata. | Physical device inventory, representative cohorts, repeated A/A noise and instrumentation-on/off calibration. |
| 2. Behavioral CI | Required `CI / ci` depends on serialized gameplay/touch/reconnect smoke; separate V8 coverage report; weekly/manual full integration. | Observe the new required lane in GitHub after an authorized push. No coverage threshold or performance regression threshold is claimed. |
| 3. Realtime | Owned production-build client and real `ws` load entry points; raw intervals, state delivery, joins and failures; clean/normal/degraded FIFO impairment profiles. | Real mobile network/browser suspension and deployed generator runs; sustained acceptance at staircase boundaries. |
| 4. Client | Coalesced resize notifications; unchanged backing dimensions preserve canvas pixels; hidden pages release input and reset presentation debt on return; opt-in update/render/decode/apply observations. | Phone CPU/allocation/raster profiles before contour/HUD caching, pools or quality changes. No evidence currently justifies worker rendering or WebGL. |
| 5. Server | Monotonic scheduling; one-second maximum simulation debt with discarded time reported; outbound pressure audit and bounded diagnostics; differential grid experiment. | Deployed tick-deadline/GC/queue distributions, tick-local allocation profiles and capacity soak. Grid candidate rejected in [the experiment](collision-experiment.md). |
| 6. Protocol | Existing enhanced keyframe/delta path retained; Unicode byte accounting and an isolated compression experiment. | End-to-end cadence/interpolation/correction and real WebSocket compression under load. Binary and interest management remain unjustified without these results. |
| 7. Operations | Opt-in 15-second aggregate exports, release-correlated health metrics, read-only Railway inventory. | Dashboard/cohorts, measured region suitability and admission reserve, physical-device and deployed-load soaks, two-player deployment verification. |

## Runtime behavior

The simulation remains at 60 Hz and snapshots at 30 Hz. A server scheduling stall
can catch up at most one second of game frames; longer wall time is discarded and
counted. Game-frame timers and simulated entity motion progress through the
frames actually simulated. Motion receives an explicit simulation delta instead of
re-measuring wall time within each catch-up tick. Wall-clock reconnect grace
remains wall-clock based. A visible client resumes
with a zero presentation delta and requests current authoritative state.

Client metrics are opt-in at `/?performance=1`; `/?performance=collect` retains
raw observations for an external driver to drain. Instrumentation lives in
`src/diagnostics/`; workload generation stays in `benchmarks/`. Timing measures
CPU submission and animation scheduling, not GPU presentation. Input timing starts
at event-handler observation and ends at render submission, so it excludes
hardware input latency and display scanout. Each phase/metric retains at most
4096 values and reports omissions; periodic exports report retained-sample p95,
not an undisclosed whole-session percentile.

Server metrics are enabled with `GEOROIDS_PERFORMANCE=1`. `/health` then includes
process diagnostic histograms, GC pauses, event-loop delay/utilization, memory and outbound
outcomes in `metrics`. Metrics are a process aggregate; multiple in-process server
instances share the exporter until the last instance closes. Histograms use fixed buckets; their percentiles are upper-bound bucket
estimates, except the native Node event-loop histogram. Fifteen-second exports
reset the window. Repeated health polls overlap and must not be summed as
independent windows. Instrumentation stays disabled by default until overhead
and sampling policy have been measured.

## Production evidence and deployment

[The September 9 read-only Railway inventory](production-inventory-2026-09-09.json)
records low utilization while the world was idle. The deployed server release
was `75995f58b4de340e16db94d9439bbfb57c6f8ea0`; this is not evidence for this branch.
The service had pre-existing staged changes belonging to another operation.
The configuration reports one replica in `iad`, Railpack and the V2 runtime.
No deployment settings were changed and no remote load was offered. Player RTT
and a tested admission reserve are still unmeasured.

Use the repository's branch/PR/CI-gated merge path for client delivery. These
server changes also require a separate Railway deploy. Before acceptance, verify
both `x-release-id` headers, current health, two real players, and reconnect.
Deploy the merged commit using Railway's active configuration, preserving the
unrelated staged operation. Keep one
authoritative process per world; replicas need room and reconnect routing before
they can provide correct additional capacity.

## Verification receipts

The full integration run completed on September 9 at approximately 10:40
UTC: **60 files and 110 tests passed, with no skips**. Its log is
`.performance/integration-reviewed.txt`, and the owned runner released the shared
repository lock. The full gate subsequently passed at `10baef5` in
`.performance/gate-completion-audit.txt`. After reconciling `a83028a`, six browser
files passed ten tests, including direct controls, touch lifecycle, rejected-join
retry and desktop/mobile Wiki layout; four focused unit files passed 26 tests.
The combined browser log is `.performance/reconcile-direct-controls.txt`.
Coverage passed an earlier revision's 1,103 tests; it is not a final-tree coverage
claim. The pre-ship full working-tree gate passed after the disconnect-cause
correction and Wiki review: lint, YAML, actionlint, runner/dev-server contracts,
TypeScript, benchmark TypeScript, unit tests and production build. Its log is
`.performance/gate-final-a83028a.txt`. The correction separately passed all 11
network unit scenarios and both desktop/mobile rejected-join retry scenarios
(`.performance/final-join-classification.txt`). Independent review found no
remaining defect in those corrected paths. Subsequent ship review hardened CI
credentials, repaired enhanced-session recovery after an event write failure,
and corrected attached motion during fixed-tick catch-up. The earlier timed
reports do not describe the final shipping source hash.

The archived motion receipts below cover the former attached Hauler tool path;
they remain historical evidence and do not describe the current game. At that
revision, 29 motion unit scenarios passed, including normal-tick/hitch
equivalence and wall rollback with reconnect grace. The hitch regression failed
against the old motion integration before that temporary mutation was removed.
Four Hauler/reconnect/desktop-mobile Wiki integration scenarios and 27
recovery/benchmark unit scenarios passed with no skips. Their logs are
`.performance/ship-motion-unit.txt`, `.performance/ship-motion-integration.txt`,
and `.performance/ship-review-network-tests.txt`. The desktop/mobile Wiki and
live Hauler captures were inspected and the source review recorded. The full
gate then passed in `.performance/ship-gate-review.txt`, including the complete
unit suite and production build.

The independent final benchmark review found no remaining findings in the
reviewed delivery denominator, RTT completeness, proxy cleanup and authoritative
shot-witness paths. The corrected five-pilot load driver completed 30 seconds of
warmup and 180 seconds of measurement with no failures and complete cleanup:
26,405 states, 29.34 states/second per pilot and all 180 measured RTT replies.
Negotiated pilots witnessed authoritative measured shots; legacy protocol lacks
that witness. The default world starts with 20 asteroids and two bots, so this
does not validate the proposed loaded-battle or capacity target. Raw evidence is
`.performance/load-completion-audit.json`; [optimization decisions](optimization-decisions.md)
records tail timings and workload limits. Guard
false positives are recorded separately as an unclaimed agent investigation in
[Todoist](https://app.todoist.com/app/task/6hRwh4VwWw8mrW2m).

The sustained production-build client run passed all three Chromium viewports
with 30 seconds of warmup and 180 seconds of measurement each. Raw report:
`.performance/client-sustained-final.json`. Its source/build hashes matched at
completion, cleanup completed, and every browser error/warning list was empty.
These are Apple M3 desktop-hosted contexts, including emulated touch; they are not
the strategy's five-minute physical-phone acceptance runs.

| Viewport | Measured play + respawn frames | Play CPU p95 / p99 | Natural game-over rejoins, including warmup |
| --- | --- | --- | --- |
| Desktop 1280×900 | 9,750 | 2.1 / 2.3 ms | 5 |
| Touch portrait 390×844 | 9,755 | 1.8 / 2.0 ms | 6 |
| Touch landscape 844×390 | 9,695 | 2.0 / 2.3 ms | 6 |

Play frame intervals had p95 16.7 ms and p99 16.8 ms in each case. Those phase
samples exclude the menu/rejoin pauses, whose full durations remain in the report;
they do not represent uninterrupted whole-session frame delivery. No retained
metric samples were omitted. Desktop play recorded 655 input-to-render samples
with p95 14.9 ms and maximum 16.9 ms. Each touch case recorded only five such
samples because the workload holds its touches; that is insufficient for a touch
latency budget. Initial joins measured 134.7, 112.9 and 113.1 ms respectively,
with one initial join per viewport, not controlled cold/warm page-cache cohorts.

The final raw server log retained seven movement-envelope rejection records and
one snapshot write EPIPE at the desktop-to-portrait teardown boundary. Repeated
rejection logging is rate-limited, so seven is not a total rejection count. Six
records coincide with boundary damage/death; one desktop record remains
unclassified. The combined validation reason does not prove which predicate
rejected each pose. These observations do not establish a performance bottleneck,
and the browser-error gate does not certify that every server command was accepted. The earlier failed run
is preserved in `.performance/client-completion-audit.json`; it exposed invalid
touch cancellation and warning severity on requested disconnects. After the
successful sustained run, a diagnostic-only correction distinguished automatic
join failure from requested disconnect without changing retry behavior; its
source hash therefore differs from the timed report.

Local evidence is retained under `.performance/`, with browser captures under
`tests/integration/browser/screenshots/`. Development behavioral checks passed
boot/move/fire, sustained simultaneous touch steering/fire, ability/shield,
cancellation, rotation, mixed legacy/enhanced reconnect, and desktop/mobile manual
layout. The five scenarios passed with no test skips. Console diagnostics during
the checked interactions were clean; server-side transport-close messages during
owned teardown are expected and are retained in the log.

Visual inspection covered `/` at 1280×900 and 390×844, plus mobile rotation to
844×390. Controls remained inside the viewport and gameplay was exercised.
`/wiki/#hud-network` was checked at 1280×900 and 390×844 as a copy/render check.
Captures: `performance-desktop.png`, `performance-mobile-portrait.png`,
`performance-mobile-landscape.png`, `performance-wiki-desktop.png`, and
`performance-wiki-mobile.png` in the screenshot directory above.

The pixel-preservation and hidden-page/input unit scenarios pass. Controlled
defects confirmed that the regression tests reject unnecessary bitmap clearing
and repeated clock-debt replay; the defects were removed immediately afterward.
A native isolated Node GC smoke produced three observed events, and lifecycle
checks cover observer shutdown and window resets. The TCP
impairment check delivered a complete 256 KiB byte stream in order and closed both
ends. These browser emulations and unit checks do not replace actual phone tests.
