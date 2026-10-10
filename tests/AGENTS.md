# Writing GeoRoids tests

Tests explain a player or system event and prove its expected behavior. Prefer a
small, trustworthy suite. Coverage percentage and test count are not goals.
GeoRoids does not write or run browser tests. All automated tests execute code
without launching a browser. Do not add Playwright, Cypress, WebDriver or other
browser correctness suites.
Do not add browser suites or browser CI lanes. Manual browser testing is limited
to brief smoke checks of the affected page and control, including desktop/mobile
widths for layout changes. Avoid elaborate browser harnesses, scenario matrices,
and multiplayer regression workflows. Svelte/jsdom component tests and canvas-call
tests execute code in the runner; they do not launch a browser.

## Suites

- `unit/`: deterministic rules, executed DOM/canvas behavior, protocol and failure boundaries.
- `integration/server/`: server modules and owned loopback protocol interactions.
- `integration/entities/`: entity interactions and input behavior.

Native browser rendering, real keyboard/touch behavior and audio are outside
automated code coverage. Basic manual smoke checks do not certify those exhaustively.

## Arrange, act, observe

1. Arrange explicit participants, IDs, positions, health, protection state and
   clocks. Use a fresh world or object graph for each test.
2. Act through the boundary being tested: input handler, socket message,
   collision resolver, lifecycle tick or public API.
3. Assert a result that fails when the behavior breaks: exact damage, identified
   victim/projectile/drop, credited score, death cause or lifecycle transition.

Name the event and outcome, rather than the implementation function. Setting
health to zero and asserting zero does not test death. Snapshot mutable
preconditions by value. Await asynchronous operations, assertions and cleanup.

## Deterministic setup

- Use fixed seeds and controlled clocks when elapsed time affects the result.
  Advance explicit ticks rather than starting an unnecessary real-time loop.
- A manual simulation frame does not necessarily advance the server clock.
  Inspect shared fixtures and production deadlines, including reconnect grace,
  projectile expiry, pose age and saved-flight restoration.
- Reset worlds, singletons, mocks, clocks and configuration between cases.
- Include only the actors and world needed for the interaction. Identify targets
  explicitly and disable unrelated motion, contours or hazards when appropriate.
- Keep helpers small and reuse production geometry rather than implementing a
  second physics engine.
- Delete any case without a solid deterministic result. Do not hide failures
  with retries, skips, broad tolerances, weaker assertions or longer timeouts.

Use bounded condition waits for owned I/O. A cleanup/watchdog deadline bounds a
failed operation; it is not a speed assertion. Fixed sleeps do not prove that an
action succeeded. Control the clock when passage of time is the rule being tested.
Observe transient events before triggering them.

## Put proof at the right level

| Level | Use it for |
| --- | --- |
| Unit | Game rules, geometry, protocol validation, state transitions, executed DOM/canvas calls and failure boundaries. |
| Server integration | Owned real transport negotiation, authoritative state and server lifecycle. |
| Entity integration | Interactions between components/entities through real operations. |

Mocks control external boundaries or failures; they must not return the exact
outcome being claimed. Source-token matches cannot prove game behavior or drawing.
Observe executed canvas calls or DOM state for those claims. Static contract tests
may inspect configuration or dependency policy when that is the actual contract.
Keep independent known positions, counts or ratios when expected geometry uses a
production helper, so the helper cannot change both sides of the assertion.

Keep negative cases for invalid ownership, malformed commands, production-disabled
controls, limits, failed writes and deadlines. Trigger the actual rejection or
failure. Give concurrent operations distinguishable results. Diagnostics cases
must trigger the transition or transport/write failure before inspecting the
correlated record; hand-authored log envelopes do not prove runtime logging.

Shared transport fixtures live in `tests/support/`. `RecordingSocket` models an
in-process boundary; `WireClient` owns a real loopback connection and bounded
cleanup. Random private token values are compared only within their owned run.

## Higher-risk refactors

Use deterministic generated cases for high-risk algorithms. Compare snapshot
decode results with canonical public state across add/update/remove/order/clear,
keyframe, invalid-baseline and capability transitions. Compare collision
acceleration with brute-force results for seeded worlds, edge overlaps, large
objects and swept projectiles. Compare clocks over equal elapsed durations at
30/60/120/144 Hz, including pauses and backward wall-clock changes.

Server integration exercises real join/shoot/damage/death/respawn, unsupported
clients, resync, rate limits, delayed send callbacks, disconnect cleanup and
restart behavior. A transport benchmark fails on invalid state, missing
acknowledgements or stalled gameplay even when throughput is high.

For each algorithm refactor, include a deliberate mutation or controlled defect
that the regression test rejects, such as ignoring a snapshot clear or missing a
cell-edge collision. Remove the defect before committing.

Coverage uses the installed `@vitest/coverage-v8` provider or the manual Coverage
report workflow, separately from benchmarks. Protect high-risk branches and
known scenarios; line coverage alone does not prove reconnect or collision
semantics. There is no repository-wide percentage merge threshold.

## Consolidate

Find the canonical scenario before adding a test. Extend it when the assertion
belongs to the same story. Delete unconditional passes, placeholders,
assignment-only assertions and weaker duplicates. Record lost coverage honestly.

## Run and report

Run commands from the absolute GeoRoids checkout directory:

```sh
npm test                           # complete unit suite
npm run test:all                    # units and complete integration
npm run test:integration            # complete server/entity integration
npm run test:integration:server     # server integration
npm run test:integration:entities   # entity integration
npm run test:coverage               # unit coverage, no percentage merge threshold
```

Focused units may use `npx vitest run tests/unit/<scenario>.test.ts`.
Always use `./scripts/test-runner.sh` for server/entity integration; never raw
Vitest on `tests/integration/`. The runner owns one isolated Vitest worker and
per-run artifacts, stops only its process tree and defaults to a 1200-second
execution deadline (`GEOROIDS_TEST_MAX_DURATION_SECONDS`); timeout exits 124 and
stops owned processes. Socket scenarios create and close their own port-zero
loopback servers; the code runner starts no Vite/server pair. Run the complete literal server/entity inventory
with `npm run test:integration`; there is no shard or browser lane.

Integration selectors must name literal files or directories within the
server/entity inventory, using repository-relative or absolute paths. Missing
files, substring selectors and `:line` suffixes fail. Put selectors directly after
the runner command; a nonempty `--` tail is rejected.

```sh
./scripts/test-runner.sh tests/integration/server/server-pause.test.ts --reporter=verbose
```

Keep `pool: 'forks'`, `maxWorkers: 1`, `isolate: true`, `fileParallelism: false`,
`sequence.concurrent: false` and `maxConcurrency: 1` in `vitest.config.ts`.

Code checks may overlap across different worktrees. Validation in the same
checkout admits one gate, review or standalone harness at a time because builds
and artifacts share ownership. Failed cleanup retains the admission barrier. Do not attach to an existing developer service.
Cleanup failures fail the run. Report the commands actually run, skipped checks
and removed coverage. Any skipped or quarantined case needs a reason and repair
step; it never counts as a pass. `npm run gate` remains the complete pre-publication gate.
All enabled lint findings are errors; do not add suppressions to get green.
Retain printed artifact directories and actual exit results outside tracked
source. Do not commit generated logs or reports.

## Basic manual browser smoke

Open the affected page, try the changed control or a short join/steer/fire flow,
and check obvious rendering and console errors. Use desktop and mobile widths
when layout changes. Keep checks brief and report what was actually observed.
Do not build a browser harness, long scenario matrix or multiplayer regression
workflow. Deterministic code tests own regression coverage.

## Manual performance and media tools

Keep measurement fixtures under `benchmarks/`; production must not import them.
Deterministic benchmark contract tests prove workload validation or cleanup, not
elapsed-time thresholds or native browser comparisons. Browser benchmarks,
frame measurements and Wiki media generation are manual tools outside the gate.
Playwright is retained for them. Manual runner/frame measurements enter the
common-Git heavyweight queue and retain their complete outcome and cleanup evidence.

Compare equivalent scenarios with a pinned harness and preserve raw samples,
participants, final state and exact work counts. Timing and frame pacing need
calibrated repeated measurements. Follow [benchmark guidance](../benchmarks/README.md).
