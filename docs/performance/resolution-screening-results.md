# Accelerated browser resolution screening

The current accelerated desktop browser shows no FPS benefit from capping the
game canvas at DPR 2. Production therefore keeps native resolution and full
glow. This does not reject DPR 2 for a slower phone GPU; it rejects promoting
that preset from these desktop results.

The six short sessions use the same product and harness sources, seed-42 combat
fixture, 390×844 touch viewport, device DPR 3, CPU slowdown 4, clean loopback
network and Chromium 153 on Apple M3 Metal. Actual effective DPR and backing
dimensions were checked. Each session has 15 seconds warmup and 30 measured
seconds, with no tracing or CPU profiler. The order is one unchanged A/A pair,
then two alternating A/B pairs.

| Session | Render DPR | Frames over 25 ms | Frame interval p99 | Render submission p95 | Input to render p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| A/A first | Native | 0% | 16.8 ms | 2.4 ms | 17.1 ms |
| A/A second | Native | 0% | 16.8 ms | 2.2 ms | 17.1 ms |
| A/B first control | Native | 0% | 16.8 ms | 2.4 ms | 16.4 ms |
| A/B first candidate | 2 | 0% | 16.8 ms | 2.4 ms | 16.5 ms |
| A/B second candidate | 2 | 0.056% | 16.8 ms | 2.4 ms | 16.7 ms |
| A/B second control | Native | 0% | 16.8 ms | 2.4 ms | 16.4 ms |

All six sessions passed gameplay and cleanup checks with no browser warnings
or errors. The browser observed 757–881 acknowledged motion states and 46–64
projectiles per session. Every protocol peer completed its workload and observed
measured server projectiles. Measured population samples retained five humans,
two bots and two pickups. Asteroids, then-current hostile satellites, projectiles
and game-over restarts varied as the live battles evolved; their distributions
are retained in the receipt. These are repeated workloads, not identical
replayed worlds. Live play no longer has hostile satellite NPCs.

The native and capped screenshots were inspected. Both retain hulls, projectiles,
labels, radar and controls; the capped image is softer. That visible tradeoff
has no demonstrated frame-rate payoff on this host.

This screening does not satisfy the existing three-A/A, three-A/B five-minute
comparison gate, and it does not establish phone, battery or thermal performance.
Neither the 55.6% backing-pixel reduction nor the earlier software-raster results
can substitute for that evidence. The [phone setup follow-up](../phone-testing-setup.md)
remains the way to test this tradeoff on older Android hardware.

The [receipt](resolution-screening-receipt.json) records source and raw artifact
hashes. Local reports, logs, screenshots and the runner are in
`.performance/resolution-current/`. Fixture checks use JavaScript serialization
to reproduce the recorded manifest hashes; repeated uses of the same fixture
after a game-over are allowed and retained. No source or production quality
setting changed during or after the screening.
