# Loaded server CPU, allocation and admission decisions

The loaded profile is now captured. Retain live-entity array ownership, retain
recipient visibility/filtering rules, and retain `MAX_PLAYERS=100` as a
provisional hard admission ceiling. None of these decisions certifies 100 human
players. The measured local 25-pilot run did expose a sustained snapshot-rate
limit and a fully busy server event loop.

## Decisions

| Question | Decision from this evidence |
| --- | --- |
| Cache live entity arrays? | No. `EntityManager.getAllEntities` accounts for 0.055–0.159% of sampled main-isolate wall time and 0.023–0.034% of estimated allocated bytes across all four profiles. A persistent cache would add membership/invalidation and shared-array ownership obligations for a small measured cost. Keep the current accessors. |
| Reshape per-player snapshot filtering? | No broad rewrite or shared private rows. `nearbyWorldRows` and `nearbyAsteroidRows` each account for less than 0.25% of sampled wall time and less than 0.09% of estimated allocation. Recipient loot queries cost 3.96–5.54% of wall samples, while snapshot capture/copy/diff work is much larger. A targeted query or snapshot-copy experiment is better grounded than changing visibility, privacy or all recipient filters. No such implementation or improvement claim is made here. |
| Change `MAX_PLAYERS`? | No numeric code change from this experiment. Keep 100 as a provisional hard admission/resource ceiling, with no supported-concurrency promise. Ten synthetic pilots met the existing delivery references; 25 retained valid gameplay but delivered about 15.3 states/s. The evidence supports a local main-loop throughput concern, not a production capacity number or a safe replacement cap. |

Changing these decisions requires a candidate that preserves ownership, privacy,
decoded state and gameplay outcomes, followed by the repository's calibrated
comparison procedure. A concurrency promise additionally needs an independent
generator with demonstrated headroom, representative world/persistence work,
matched server hardware and a sustained boundary run. A larger CPU allocation
does not multiply the throughput of the single Node game/event-loop thread.

## Recorded source and workload

All eight final sessions used clean committed source
`b741509c852a096d0b40e23108eaf01c6158b0b0`, seed 42, Node 26.13.1, Linux x64,
and an Intel Xeon Platinum 8573C host. The VM exposed five logical CPUs with a
four-CPU quota, `cpu.max=400000 100000`, and a 16 GiB memory limit. Server and
generator shared that quota. The production 24-CPU limit reported by the separate
operations review is a different configuration, not a measured speed multiplier.

The Node-only tool owns a port-zero server child and real negotiated synthetic
pilots. Both scenes start with 80 seeded rocks, five Scouts, five Haulers and
five actual tow-cable attachments. The driver offers 20 movement commands and
two aimed shots per second. Snapshot completion requires contiguous sequences,
measured authoritative motion acknowledgments, authoritative projectiles born
afterward and answered measured pings. The server separately records positive
damage/destruction and motion of all five original tow targets.

The natural case retains ordinary materials, health and phenomena. Destruction
and fragmentation continue without resets or top-ups. The endurance companion
starts rocks as metal with finite health 100000. Reflective phenomena still
destroy five rocks during preparation/warmup. Its measured 75-rock load omits
ordinary material destruction frequency. Initial grid placement is synthetic
and does not reproduce natural regional-field or reflective-pocket geometry.

All six ten-pilot sessions had 10 seconds of warmup and approximately 45 measured
seconds. The first four recorded main-isolate CPU profiles at 1 ms and allocation
samples at 32 KiB, including objects collected by major and minor GC. The last
two were unprofiled observations. Persistence was excluded for these six cases.
Every session retained five live tows throughout measurement, all ten pilots
completed, and no pilot crossed the existing delivery references.

| Session | Measured seconds | Measured rocks | Original rocks destroyed during measurement | Peak new rocks | Per-pilot states/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| `natural-p1` | 45.034 | 51–67 | 24 | 13 | 28.98–29.00 |
| `endurance-p1` | 45.061 | 75 | 0 | 0 | 29.43–29.46 |
| `natural-p2` | 45.004 | 57–70 | 27 | 21 | 29.02 |
| `endurance-p2` | 45.065 | 75 | 0 | 0 | 29.41–29.43 |
| `natural-unprofiled` | 45.061 | 53–69 | 27 | 19 | 29.34–29.37 |
| `endurance-unprofiled` | 45.005 | 75 | 0 | 0 | 29.87 |

The natural runs ended with 53, 56 and 55 loot rows respectively; the endurance
profile/control runs ended with no loot. Their evolving outcomes differ. These
are attribution repeats, not exact-outcome A/A pairs or an A/B timing comparison.
The unprofiled server CPU observations were 71.3% for natural and 62.1% for
endurance, expressed relative to one core. Different outcomes and profiling
overhead prevent treating those differences as a causal speed comparison.

## Allocation and CPU attribution

The percentages below are inclusive named-method attribution across the four
profiles. CPU percentages include idle samples in their denominator. Inclusive
rows overlap and must not be summed. V8 allocation sizes are estimates of
allocated bytes, including collected objects, not retained heap or a leak test.

| Named method/path | Sampled wall-time share | Estimated allocation share |
| --- | ---: | ---: |
| `EntityManager.getAllEntities` | 0.055–0.159% | 0.023–0.034% |
| `GameEngine.getAllPlayers` | 0.019–0.066% | 0.017–0.021% |
| `nearbyWorldRows` | 0.160–0.240% | 0.028–0.049% |
| `nearbyAsteroidRows` | 0.186–0.237% | 0.043–0.088% |
| `GameEngine.getNearbyLoot` | 3.957–5.537% | 1.223–1.814% |
| `SnapshotEncoder` | 13.915–19.633% | 14.223–16.280% |
| `GameStateBroadcaster.broadcastGameState` | 45.190–56.307% | 63.519–66.456% |

Broadcasting accounts for 66.96–68.97% of non-idle CPU samples. Snapshot field
enumeration, collection patches, DTO conversion, ownership copying and JSON
serialization are larger costs than the entity-array getters or generic
interest filters. `LootManager.inBounds` also accounts for 8.78–10.17% of all CPU
samples and 18.95–19.42% of estimated allocation across its callers. Those callers
include both recipient loot queries and per-laser arm-range loot queries in
`resolveEnhancedLaser`; its full cost must not be assigned to snapshot filtering.

The profiles estimate 19.95–22.55 GB allocated per measured window. That figure
describes sampled allocation churn under profiling, not live RAM. Transformed
TypeScript modules appear at line 1 in these profiles, so anonymous locations
coalesce. The decisions above use named methods; raw profiles retain the
original call frames for further inspection.

## Local capacity observation and its cause

The staircase used fresh unprofiled processes, 10 seconds of warmup, 30 measured
seconds and real file-backed worker persistence in each artifact directory.
Extra pilots occupied the declared grid near the same field. Test mode bypassed
connection/message admission budgets while retaining the 100-player ceiling.

| Observation | 10 pilots | 25 pilots |
| --- | ---: | ---: |
| Measured seconds | 30.066 | 30.042 |
| Rocks | 75 | 68–70 |
| Completed pilots / live tows | 10 / 5 | 25 / 5 |
| Per-pilot states/s | 29.65–29.68 | 15.30–15.33 |
| Largest decoded gap | 122.7 ms | 142.6 ms |
| Server process CPU, relative to one core | 63.8% | 107.6% |
| Driver process CPU, relative to one core | 31.5% | 75.9% |
| Simulation ticks | 1804 | 1805 |
| Scheduled simulation callbacks | 1596 | 460 |
| Accepted snapshots | 8920 | 11500 |
| Measured server event-loop utilization | 0.561–0.655 | 1.000 |
| Pending worker batches at boundary | 0 | 0 |

The 25-pilot result is valid protocol/gameplay completion with a sustained
state-rate reference overrun on every pilot. It is not an omitted-sequence or
250 ms gap failure. The server accepted 460 snapshots per pilot, matching the
459–460 decoded measured states. No snapshot send failed, skipped for pressure
or closed for pressure, and all measured pings were answered.

The server still advanced 1805 authoritative ticks, about 60.08/s, by catching up
multiple ticks per scheduled callback. Its event loop was fully active in every
measured metric window. Broadcast p99 bucket upper bounds were 100, 100 and 50 ms;
timer-lateness p99 bounds were also 100, 100 and 50 ms. Event-loop delay p99 values
were 122.4, 114.6 and 59.9 ms. The broadcast histogram includes both snapshot and
gameplay-event broadcasts, so its count 2618 is not the periodic snapshot count,
and its durations cannot be summed with tick/GC durations as disjoint CPU work.

These observations support main-loop saturation and delayed snapshot scheduling
as a plausible local limit. The 25-pilot case was not CPU-profiled, so the exact
hot functions at 25 are not isolated. Whole-process CPU includes worker/GC
threads. Driver 75.9% CPU does not establish transient generator saturation,
although headroom for the next step remains unproven. Persistence stayed healthy
with 46 committed batches, zero pending and a last commit of 1.27 ms. No simulation
debt was discarded. None of these facts proves production capacity, and a 24-core
limit does not remove a single-thread bottleneck.

Steps 50 and 100 were not run after this delivery boundary and unresolved
higher-step generator headroom. The result settles the current code policy:
retain 100 provisionally, do not certify it, and do not lower it solely from this
shared-host staircase. The existing 27 Hz/250 ms references remain report-only;
no numeric CI gate or supported-player claim was added.

## Reproduce and inspect

Use the committed [loaded-server commands](../../benchmarks/README.md#loaded-server-cpu-and-allocation-profiles).
The exact six-session execution plan is retained at
`/workspace/work/loaded-profile-run-plan.sh`, SHA-256
`a6955c145b9f4f145ac6d4cbf23f0fd16d9d52c95bf6420f3c018b688d3f6cd3`.
Raw artifacts are outside the checkout under
`/workspace/work/loaded-battle-b741509c/`, in the session directories named above.
Each contains the actual fixture bytes/hash, driver report, server metric windows,
per-second populations, stdout/stderr and final runner cleanup receipt. The four
profile directories additionally contain `server.cpuprofile`, `server.heapprofile`
and the committed reducer's `attribution.json`.

`audit.json` records all source fingerprints, scenario parameters, machine facts,
raw byte counts/hashes, selected finalized metric window IDs and aggregate work.
Its SHA-256 is
`f558631884ba8ae1d39d8dc7df361f3efede95ac59422f57a11c0cbb0d9b43fc`.
The rerunnable audit tool is `/workspace/work/loaded-profile-audit.py`, SHA-256
`c0367ebbc4790ad546cd49069046232d8d6b98abba0f2aad01cee5307ed262fb`.
It verified all eight clean pinned sessions, every retained runner artifact hash
and all cleanup receipts. It selects the finalized post-boundary window suffix
that reconciles with the independent measured interval, recording the actual
clock discrepancy. The capacity discrepancies were 0.68 and 0.83 ms. Pre-warmup
windows are excluded and no overlapping health samples are summed.

The trusted commit hook passed 414 unit files/2488 tests, build and complete server
integration at `.performance/gate/run.23R9cu`. The explicit committed-head gate
passed at `.performance/gate/run.5sHZDJ`, with verified code/review reuse and a
new HEAD build. Source stayed clean and unchanged during all eight sessions.
Every session awaited owned socket closure and server exit; admission independently
proved its issued process group absent. The quiet measurement window ended after
the 25-pilot step.

Earlier correctness 01–05 are invalid for fixture provenance because a digest was
computed after live rows could move during an awaited write. The fixed tool
serializes once, hashes those bytes and verifies the retained file. A real-I/O
mutation regression rejects the old defect. Correctness 06 passed that check and
cleanup but remains a dirty setup diagnostic. The failed wrapper attempt,
owned-record recovery, canceled gate and failed Wiki-digest build remain retained.
No successful frame measurement, browser verification, production load or human
capacity result is claimed. No in-game Wiki page or production configuration
changed for this work.
