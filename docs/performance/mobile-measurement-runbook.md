# Mobile performance measurement runbook

## Scope and prerequisites

Use this runbook with the [mobile performance research](../mobile-performance-research.md). Constrained browser runs are the primary repeatable optimization baseline. Physical devices validate whether measured changes transfer to phone hardware; unavailable phones do not block browser investigation, general optimizations or browser regression budgets. No physical-device run or performance improvement is certified by this document.

Record a baseline before editing rendering or network behavior. Use a clean, committed checkout for pinned benchmark comparisons. Run timing work alone, without simultaneous tests, coverage, builds, or another load generator. The existing benchmark harness records source and dependency provenance; its [guide](../../benchmarks/README.md) describes the difference between archived revision comparisons and current-worktree realtime sessions.

DPR and glow candidates are implemented as diagnostic overrides. Normal desktop and touch rendering remains native DPR with full glow pending physical acceptance. See the [quality decision ledger](mobile-quality-decisions.md) for controls, tradeoffs, and retirement criteria. Cadence and other optimizations still require measured attribution.

## Browser optimization sequence

1. Freeze and hash the source, harness, dependencies and browser version. Run timing
   alone. First use portrait, CPU 4, DPR 3, clean networking and seeded combat.
   Verify the constraint and raw recording before scheduling a full batch.
2. Measure three A/A pairs. Keep at least 300 seconds of foreground samples and
   300 distinct input observations per session; allow extra wall time for rejoins.
   Record all failed attempts. Compare session-level results to establish noise.
3. Run three alternating A/B pairs for each independent change: the historical
   player-only minimap candidate, DPR cap 2, DPR cap 1.5, and glow off. Check
   workload equivalence and source provenance rather than relying on identical
   command-line arguments. The current minimap includes live asteroid, loot,
   satellite, loose-pickup, and orbiting-pickup marks; any performance claim for
   that policy needs a fresh matched comparison.
4. Use phase timings and browser profiles to select general optimizations. Isolate
   rendering, client processing and network delivery; keep gameplay and visual
   behavior intact unless a documented quality experiment explicitly changes it.
   Repeat the matched comparison for each selected optimization.
5. Confirm improvements in landscape and under the normal network profile. Keep
   the degraded network workload as a separate capacity investigation. Fix
   attributable delivery bottlenecks and repeat its constrained test.
6. Encode regression budgets from stable browser evidence, with short correctness
   checks in PR CI and repeatable longer performance comparisons. Keep the
   sustained 60 Hz target separate from a budget calibrated to this host/browser.
7. Run the full gate and affected browser scenarios. Record raw artifacts, hashes,
   paired effects, failures and remaining uncertainty. Use occasional phone traces
   to validate transfer; do not substitute phone anecdotes for the browser baseline.

## Repository diagnostics

Run the following commands from `/Users/johnsolly/code/GeoRoids`. They exercise local workloads, not physical phones or Railway production capacity.

```sh
cd /Users/johnsolly/code/GeoRoids
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport touch-portrait
```

Then run sustained client and load sessions separately:

```sh
cd /Users/johnsolly/code/GeoRoids
npm run benchmark:realtime -- --viewport all --warmup 30 --seconds 180 --output .performance/mobile-client-baseline.json
npm run benchmark:load -- --pilots 5 --warmup 30 --seconds 180 --output .performance/mobile-load-baseline.json
npm run benchmark:load -- --pilots 5 --network degraded --warmup 30 --seconds 180 --output .performance/mobile-load-degraded.json
```

These npm commands use the repository runner and its process ownership and integration lock. Do not replace them with raw Vitest integration commands. The impairment model delays and throttles an ordered local TCP path; it is not a cellular modem or a complete packet-loss model. The default world and five pilots do not establish dense-combat or capacity acceptance.

The comparison CLI trusts reports produced by the current verified harness; it is not an independent audit of fabricated or manually edited witness sections. It validates raw timing/phase coverage and checksums, retains source artifact references, and requires complete producer reports. Keep the corresponding runner logs and constraint witnesses for review.

Before each candidate, repeat the same workload with the same seed and record counts and game outcomes. Use the pinned comparison command only with real committed baseline and candidate revisions. Consult the benchmark guide for its alternating comparisons and A/A calibration. Preserve failed reports as well as successful ones.

## Constrained browser path

The realtime harness accepts independent constraints. For example, from `/Users/johnsolly/code/GeoRoids`:

```sh
npm run benchmark:realtime -- --viewport touch-portrait --scenario combat --seed 42 --dpr 3 --cpu-slowdown 4 --network degraded --warmup 30 --seconds 300 --output .performance/mobile-combined.json
```

Use `--render-dpr native|2|1.5` and `--render-glow full|off` for independent fixed comparisons. Do not combine both changes until each has its own matched comparison. Defaults preserve native/full rendering. Reports include setup witnesses and actual population observations; a requested constraint alone is not evidence it took effect.

| Lane | Browser CPU slowdown | Device DPR | Network path | Purpose |
| --- | ---: | ---: | --- | --- |
| Control | 1× | 3 | Direct local | Matched baseline |
| CPU constrained | 4× | 3 | Direct local | Input/update/decode contention |
| Network constrained | 1× | 3 | Existing degraded proxy | Queueing, recovery, state delivery |
| Combined | 4× | 3 | Existing degraded proxy | Competing frame and receive work |
| Severe diagnostic | 6× | 3 | Existing degraded proxy | Failure behavior; not an initial FPS gate |

Run portrait and landscape, with an additional DPR 1 diagnostic when isolating pixel cost. Hold the candidate's quality tier fixed. The numbers are initial stress settings, to be calibrated against the affected device. The [report's constrained-path section](../mobile-performance-research.md#a-constrained-mobile-regression-path) cites the APIs, existing parameters, and limitations.

Harness verification requirements:

1. Extend `benchmarks/realtime-client.ts` with validated CPU, DPR, and network-profile inputs. Record them in the report schema. Apply Chromium CPU throttling before navigation and preserve it across scenario contexts. Reject unsupported browser/throttle combinations rather than silently running unthrottled.
2. Reuse `benchmarks/tcp-proxy.ts` and a single shared definition of the network profiles. Integrate proxy startup and endpoint selection with `scripts/test-runner.sh` so the built client's gameplay socket actually reaches the proxy. Preserve direct health collection and runner-owned cleanup.
3. Add setup witnesses: actual browser DPR and canvas backing dimensions, successful throttle application plus a coarse calibration probe, nonzero proxy bytes, and observed RTT/throughput change. Calibration is outside gameplay timing. A failed witness makes the run invalid, not a pass.
4. Drive the existing production gameplay path with repeated steering changes, simultaneous fire, ability/shield, death/respawn, rotation, and background/return. Require authoritative command acknowledgments and valid snapshot recovery. Add isolated disconnect/reconnect fault injection without dropping dependent application deltas.
5. Use a short PR scenario for control release, valid state, bounded recovery, and catastrophic stalls. Use scheduled/manual repeated sessions for timing comparisons and the full lane matrix. Set lane-specific delivery expectations; the clean driver's 27 states/s and 250 ms maximum-gap defaults must not be copied blindly to a deliberately congested test.
6. Add runner contract checks and focused scenario tests, update benchmark documentation, and ensure every failure path removes owned proxies, sockets, browser contexts, and servers. Retain failure artifacts and nonzero exit status.

Test the detector with controlled faults: extra repeated draw work should affect the rendering lane; an induced main-thread task should appear in input/frame timing; a slower proxy should alter delivery. Compare the expected symptom to recorded metrics rather than merely asserting that a throttling API returned success. Remove the injected faults before committing the real harness.

Do not use host-wide CPU contention to slow the browser; it also slows the server, proxy, and generator and destroys attribution. Do not emulate scarce memory by only changing a reported browser property. Use actual physical-device acceptance for GPU, memory, and thermal limits, and a separately isolated server resource test for Railway capacity questions.

## Physical-phone sessions

Available hardware: iPhone 16e; OS/Safari version and hands-on recordings remain pending. The user has no Android phone. Android acceptance is outstanding; browser emulation cannot close it. No paid service is required for implementing or checking the harness, and none has been purchased.

1. Record phone model, OS/browser version, DPR, viewport, refresh mode, power-saving state, charging state, network, geography, and both release IDs.
2. Open the production build over HTTPS on the phone. `?performance=1` enables logged diagnostics; `?performance=collect` exposes the explicit Start/Stop/Download collector. Fill in the device and conditions for comparison runs. Start after warmup, stop after the measured session, and save the checksum-bearing JSON export. Starting a new session replaces the locally saved session; download first. Recover last session restores the latest persisted recording after reload, explicitly marking interruption or corruption. Record any incomplete reason. Diagnostic candidates append `&renderDpr=2` (or `1.5`) or `&renderGlow=off`. The collector remains idle during automated benchmark collection.
3. Capture a short baseline trace on the actual phone. On Android, use Chrome remote debugging with screencasting disabled. On iPhone, use Safari Web Inspector with JavaScript and rendering timelines. Save trace files with the session identifier.
4. Run three baseline sessions with separate warmup and five minutes of measured gameplay. Include repeated direction changes and button presses, not only held inputs. Record quiet and heavy scenes separately.
5. Alternate baseline/candidate order and return the phone to comparable starting conditions. Compare resolution and glow independently before combining them.
6. Repeat the successful candidate for at least fifteen minutes. Compare early and late windows, then exercise rotation, background/return, simultaneous controls, death/respawn, and network transition.
7. Run minimally instrumented acceptance sessions and compare with diagnostic sessions. Record overhead or classify the result as inconclusive if instrumentation materially changes behavior.

Match workload counts and outcomes. Use the existing opt-in server metrics in an isolated or deliberately configured environment when attributing server work. A physical phone running against production does not by itself authorize offering load from additional synthetic players to that production world.

## Experiment record

Use one record per device, network condition, and candidate. Store durable summaries and source hashes in `docs/performance/`; keep large traces in the chosen artifact store and link their exact locations and checksums. Do not include resume tokens, credentials, or raw user identifiers.

| Field | Required entry |
| --- | --- |
| Session identity | Unique ID, UTC start/end, operator, baseline or candidate |
| Provenance | Harness/product/client/server revisions; source and dependency hashes |
| Device | Model, OS, browser, viewport, device/effective DPR, refresh mode |
| Conditions | Power state, brightness, charging, cooldown procedure, network, geography |
| Workload | Seed, warmup, measured duration, entity counts, actions and outcome witnesses |
| Frame data | Sample count, p50/p95/p99 intervals, fraction above selected threshold, failures |
| Client CPU | Update, render submission, decode and application distributions |
| Input | Distinct event count, handler-to-render distribution, cancellations and stuck inputs |
| Network | RTT replies and unanswered probes, message bytes, gaps, reconnects, recovery duration |
| Server | Tick duration/lateness, debt, broadcast time, GC, event-loop delay, queue outcomes |
| Sustained behavior | Early/late comparisons, memory trend, visible degradation, battery observations |
| Completeness | Omitted samples, menu/respawn/hidden time, instrumentation setting and overhead |
| Decision | Adopt, reject, or inconclusive; evidence and visual/gameplay tradeoffs |

Compute frame-threshold rates using the full declared foreground measurement interval. Report menus, respawns, hidden periods, and reconnects separately rather than silently excluding them. Keep raw per-session data so later reviewers can recompute distributions.

## Acceptance and delivery

Use the proposed budgets in the report only after confirming their suitability for the supported device cohort. Require an improvement beyond baseline variation, readable gameplay, and no new input or synchronization failures. A shorter CPU submission time with unchanged visible stutter is not sufficient.

For an accepted implementation, run focused tests and browser scenarios, update affected Wiki pages, remove abandoned experiment code, and complete `npm run gate` from `/Users/johnsolly/code/GeoRoids`. Integration tests must use `./scripts/test-runner.sh`. Follow `/ship` for remote delivery, then verify the appropriate Vercel and Railway releases and repeat physical-device multiplayer acceptance.

The research report is historical evidence. The implementation must be checked with unit, browser, and runner contracts before using its output; successful desktop runs do not certify phone GPU or thermal behavior.
