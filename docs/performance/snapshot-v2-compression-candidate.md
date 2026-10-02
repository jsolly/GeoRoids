# Snapshot v2 compression candidates

These are isolated, unqualified transport experiments for the packed and predicted
snapshot v2 protocol. Production compression remains disabled. The
[September 12 comparison](current-compression-results.md) rejected retained-context
levels 1 and 6 under the unchanged CPU acceptance limit; those receipts do not
qualify these different configurations or the current natural regional workload.

Only the benchmark client and server adapters read `GEOROIDS_BENCHMARK_COMPRESSION`.
Its supported values are `none`, `deflate-level1-no-context`, and
`deflate-level1-no-context-8k`; absent means `none`, and every other value fails
startup. Both candidates inject the normal `ws` server option with level 1,
memory level 5, window 15 in both directions, no context takeover in either
direction, and concurrency 4. The original mode preserves threshold 1024 bytes.
The separately named 8 KiB mode changes only that threshold to 8192 bytes, to
avoid native deflate work for smaller packed deltas while retaining compression
for larger worlds. Each requires its own comparison; results from the original
mode do not qualify the 8 KiB mode. The production entry and configuration expose
no environment switch.

The threshold avoids deflating ordinary small server controls and events. `ws`
honors it only when context takeover is disabled. Browser negotiation and native
inflation remain part of the end-to-end experiment, not the JSON callback's CPU
measurement. Threshold is a local server option, absent from the negotiated
extension header. The source-bound requested options and matching named mode in
the private server CPU receipt identify the threshold; the actual 101 header
still proves both no-context directions. It cannot distinguish 1 KiB from
8 KiB or force a browser to leave its small outgoing commands uncompressed.
See the pinned [ws 8.21.3 API](https://github.com/websockets/ws/blob/8.21.3/doc/ws.md#new-websocketserveroptions-callback)
and [compression guidance](https://github.com/websockets/ws/blob/8.21.3/README.md#websocket-compression).

## Measurement and acceptance

Freeze the product, harness, build, seed, viewport, renderer, input scheduler and
ability workload across a cohort. Run independent owned sessions serially: A/A
calibration, then A/B/A and B/A/B. A is `none`; choose exactly one named compressed
mode for B throughout a cohort. Run a separate cohort for the other threshold.
Start with the clean lane, then repeat on the degraded
1 Mbps lane. Retain every failure; a process exit or successful cleanup alone is
not qualification. Natural-world outcomes can differ, so record initial/final
manifests, actual scan populations and useful gameplay witnesses.

The private `readServerProcessUsage` operation returns cumulative whole-server
CPU microseconds (`user`, `system`), Node's monotonic `monotonicMs`, and the
requested compression mode. Read it at the same measurement boundaries in both
arms. Normalize the CPU delta by monotonic elapsed time; total server CPU includes
zlib worker work that a main-isolate V8 profile omits. The driver CPU is separate.
The probe reads no world rows or game clock and preserves the private 0600 socket
and bounded IPC reply. [Node CPU documentation](https://nodejs.org/docs/latest-v24.x/api/process.html#processcpuusagepreviousvalue)
defines these process-wide microsecond counters.

All lanes use the owned proxy; both raw TCP legs explicitly disable Nagle's
sender batching to match direct WebSocket endpoints. Clean adds no bandwidth cap
or scheduled delay. This does not disable receiver TCP delayed acknowledgments,
normal socket backpressure or platform scheduling. Live private proxy counters
bracket the same observation alongside the
independently bracketed CPU probes. `proxyTransport` retains both raw replies,
proxy instance/lane identity and driver query timing, then derives bytes and
rates from safe counter deltas and the proxy's own monotonic elapsed time.
Counters include WebSocket/HTTP framing and in-flight warmup bytes admitted to
outbound delivery during the window; they exclude TCP/IP headers and
retransmission overhead. Missing/regressed counters, changed proxy identity or
lane, failed transport, or absent measured traffic reject the experiment.
Failed observations retain actual partial windows before cleanup. Whole-session
proxy file totals and cumulative peaks remain separate diagnostics.

Keep the existing acceptance conditions: each matched normalized server CPU
increase must be no greater than the larger of 10% or same-lane A/A relative
drift; memory and event-loop behavior must stay bounded. Require the real Chromium
101 extension witness and peer negotiation, actual proxy gameplay bytes, accepted
motion and firing, matched received/applied Mineral Scan snapshots, unchanged
30 Hz offers and 60 Hz simulation, and the existing useful-update and applied-age
limits. Inflated JavaScript payload lengths and server outbound application-byte
counters are not compressed transport bytes. A passing host experiment does not
establish physical-phone or Linux/Railway acceptance.

The degraded lane permits 125,000 bytes/s downstream and 32,000 bytes/s upstream
per connection, with 90±60 ms propagation per direction.
Its nominal useful-update floor is
`max(10, min(27, floor(0.8 * 125000 / warmupAverageSerializedBytes)))`, with two
states allowed at measurement endpoints. Delivery gaps and every retained
independent server-to-applied age must remain at or below 924.288 ms. Clean
limits are 27 Hz and 250 ms. Every browser and peer must meet all numeric and
workload limits; successful runner exit or report status does not qualify a
candidate with report-only overruns. The CPU limit above remains mandatory.

The fresh paired degraded diagnostic completed both 60-second windows with
identical source, product and harness identities and no client errors or
warnings. Uncompressed browser delivery was 13.73 Hz, with a 1,935 ms maximum applied
age and a 2,351 ms gap. The 1 KiB candidate delivered 20.58 Hz to the browser, with a 996 ms
maximum age and a 1,014 ms gap; aggregate measured downstream rate fell from
616,872 to 333,401 bytes/s, while whole-server CPU rose from 46.71% to 64.82%.
Both fail freshness qualification and the candidate CPU increase is 38.78% in
this single pair. Evolving populations and different applied scan counts
prevent a calibrated causal claim. Production compression remains disabled.
Receipts: `.performance/recovery-only-degraded-a1.json` and
`.performance/recovery-only-degraded-b1.json`.

## Controlled invocations

Commands run from `/Users/johnsolly/.codex/worktrees/53e4/GeoRoids`. These are
individual serial cohort runs; change only the arm, lane and retained output name
for subsequent matched runs. The runner owns a stable proxy port, selected by
`GEOROIDS_TEST_PROXY_PORT` or the configured server port plus one, and refuses an
occupied or conflicting port. Build the first session normally, then use
`--reuse-build` for the remaining matched sessions so their built assets remain
identical. The existing endpoint and build-receipt guards remain strict.

```bash
GEOROIDS_BENCHMARK_COMPRESSION=none ./scripts/test-runner.sh --benchmark-client --renderer canvas --browser chromium --chromium-gpu --viewport touch-portrait --dpr 3 --render-dpr native --render-glow full --cpu-slowdown 4 --network clean --scenario regional-combat --seed 42 --warmup 30 --seconds 60 --output .performance/compression-v2/clean-aa-1.json
GEOROIDS_BENCHMARK_COMPRESSION=deflate-level1-no-context ./scripts/test-runner.sh --benchmark-client --reuse-build --renderer canvas --browser chromium --chromium-gpu --viewport touch-portrait --dpr 3 --render-dpr native --render-glow full --cpu-slowdown 4 --network clean --scenario regional-combat --seed 42 --warmup 30 --seconds 60 --output .performance/compression-v2/clean-aba-b.json
GEOROIDS_BENCHMARK_COMPRESSION=none ./scripts/test-runner.sh --benchmark-client --reuse-build --renderer canvas --browser chromium --chromium-gpu --viewport touch-portrait --dpr 3 --render-dpr native --render-glow full --cpu-slowdown 4 --network degraded --scenario regional-combat --seed 42 --warmup 30 --seconds 60 --output .performance/compression-v2/degraded-aa-1.json
```

For a separate 8 KiB cohort, retain its own A/A and matched A runs and use this
B invocation throughout. Reuse requires the same frozen build and endpoint.

```bash
GEOROIDS_BENCHMARK_COMPRESSION=deflate-level1-no-context-8k ./scripts/test-runner.sh --benchmark-client --reuse-build --renderer canvas --browser chromium --chromium-gpu --viewport touch-portrait --dpr 3 --render-dpr native --render-glow full --cpu-slowdown 4 --network clean --scenario regional-combat --seed 42 --warmup 30 --seconds 60 --output .performance/compression-v2/clean-8k-aba-b.json
```

No Wiki gameplay page changes: these candidates change only benchmark transport
injection and private measurement instrumentation.
