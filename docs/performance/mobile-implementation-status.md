# Mobile performance implementation evidence

The requested 25% movement and projectile slowdown is implemented, together
with measured reductions in rendering, snapshot and collision work. Steering,
firing cadence, cooldowns, damage and weapon ranges retain their behavior.
Simulation remains 60 Hz and snapshots remain 30 Hz.

Physical-phone acceptance has not run. These results do not establish that the
reported iPhone 16e/17 slowdown is fixed, a supported player capacity, or an
absolute optimization ceiling. The user moved phone setup into the
[Samsung/AWS follow-up](../phone-testing-setup.md). No account, device session,
subscription or billable fixture was created.

## Accepted changes

Phase savings below come from different controlled workloads. They cannot be
added together or translated directly into a whole-game FPS improvement.
Each linked report retains its workload, comparison, correctness and limitations.

| Change | Evidence and tradeoff |
| --- | --- |
| [Slower pace](mobile-pace-results.md) | Shared spatial speeds scale by 0.75; inverse lifetimes preserve reach. Wiki articles and demonstrations reflect the change. |
| [Asteroid collision work](asteroid-collision-work-results.md) | Fixed-tick server CPU fell 68.9% with identical evolving outcomes after geometry caching and swept-bound rejection. |
| [Contour query cache](contour-query-cache-results.md) | Isolated lookup CPU fell 95.2–96.0%, preserving candidate order and pixels. |
| [Native contour paths](contour-path-results.md) | Warm path work fell roughly 49–64%; cold construction costs more. Chromium/WebKit lifecycle correctness passed. Whole-game runs stayed near 60 Hz. |
| [Contour label widths](contour-label-width-results.md) | Exact native pixels, about 0.06 ms less work per touch frame in the isolated comparison. |
| [Snapshot field validation](snapshot-validation-results.md) | Validation CPU fell 50.1%; complete parse/decode work fell 24.2%, with identical accepted/rejected worlds. |
| [Decoder ownership](decoder-owned-input-results.md) | Removes duplicate validation and retains a detached baseline; representative delta parse/decode/retention CPU fell 14.0%. |
| [Snapshot JSON reuse](snapshot-json-reuse-results.md) | Ten-recipient encode/serialize work fell 41.0% with shared baselines and 26.8% with staggered baselines; exact wire bytes match. |
| [Selected world precision](snapshot-precision-results.md) | Four-decimal world kinematics cut fixed mixed-stream bytes by 15.9%. Every player/bot field remains exact; authoritative state is never rounded. |
| [Pending snapshot handling](pending-snapshot-results.md) | Successful pending sends no longer force unnecessary full snapshots. Selected stalled-sequence bytes fell 45.8%; noisy live candidates delivered 26–28 versus 23–24 states/s. |

The precision decision explicitly accepts a bandwidth/CPU tradeoff. Its
16,800-message browser replay completed with correct state, but failed the
strict per-phase CPU check. It is not a CPU speedup claim. Other accepted
rendering work reuses contour smoothing and drawing paths; the
[render attribution report](render-attribution-results.md) distinguishes native
M3 Metal behavior from the earlier software-browser environment.

## Alternatives tested

| Candidate | Decision |
| --- | --- |
| [C++ backend kernel](backend-language-results.md) | Isolated kernel about 30% faster, but ordinary per-query native conversion and result construction made the complete operation 12.6 times Node's time. Keep Node. |
| [Immutable decoder](decoder-owned-input-results.md) | About 29% slower in the tested configuration; keep the owned-input decoder. |
| [Extra renderer caches](render-followup-results.md) | Reject contour-label spatial indexing, viewport media-query caching and leaderboard-width caching: desktop regressions or savings below the fixed 0.02 ms floor. |
| [DPR 2 default](resolution-screening-results.md) | Six accelerated M3 sessions showed no FPS benefit; both settings stayed near 60 Hz. Keep native/full pending phone evidence. |
| [WebSocket compression](current-compression-results.md) | Level 6 and level 1 cut clean paired download bytes by about 66%, but increased server CPU by 54% and 23%, failing the fixed limit. Keep compression disabled. |
| [MessagePack](current-binary-codec-results.md) | Current-source raw bytes are 14–15% lower, but all six primary CPU pairs regressed 11.6–15.3%, beyond the fixed 10% limit. Keep JSON. |

Compression's 1 Mbps screen and 5/25-pilot ten-minute adoption soaks were not
run after both settings failed the mandatory clean CPU gate. Failed, incomplete
and superseded attempts remain in the linked receipts; a successful process
exit does not imply an adoption pass. No memory or capacity claim follows.

A hull-only remote-presentation buffer has a static projectile/hull alignment
failure witness. Lower snapshot cadence needs the documented phone quality
check. Worker rendering, a WebGL/library migration and a batched native backend
need a remaining dominant cost in sustained device/server traces to justify
implementation. The tested alternatives do not rule out every such design.

## Verification and release

The combined repository gate passes lint and policy, unused-code checks,
Markdown/YAML/Actions checks, process-runner contracts, both TypeScript checks,
the full unit suite and production build. Shipping review repaired independent
pace/range/cooldown assertions, removed timed benchmark execution from units,
corrected a stale report field and accepted a cumulative Wiki source review.
Affected semantic review is clean. The release workflow requires an exact
commit gate, green PR CI and matching production release IDs on both Vercel
and the separately deployed Railway server.

The integrated runtime also passed 11 live Wiki, touch, real-socket motion,
reconnect and fixture cases. Earlier focused checks include 19 pending-send
cases and 55 readiness cases. Benchmark readiness now waits for a fresh prepared
world using session identity, epoch, game time and sequence boundaries. An older
11.22-second fixture restart included broader driver time and is not the new
request-to-prepared-world recovery metric.

The [pace report](mobile-pace-results.md) records regenerated demonstrations,
visual inspection and gameplay verification. The
[runbook](mobile-measurement-runbook.md) describes controlled browser collection.
The [phone measurement plan](phone-fps-measurement.md) defines a fixed older
Android reference and separate iPhone/Safari acceptance.

## Measurement boundaries

Use the existing game recorder and raw frame intervals, input response and
snapshot freshness. Phone collection has explicit Start/Stop/Download,
interruption recovery, bounded storage and checksummed exports. Manual exports
do not contain every automated fixture witness and must not be relabeled as
controlled comparisons. Calibrate desktop CPU throttling against the real
reference phone; it does not reproduce that phone's GPU or thermal behavior.

Historical browser comparisons and the short constraint matrix are retained in
[optimization decisions](optimization-decisions.md),
[contour timing](contour-timing-results.md) and their raw receipts. The original
contour comparison's frame smoothness was inconclusive: its 0.88-percentage-point
median improvement was smaller than 17.99 points of baseline variation.
Earlier 1 Mbps combat attempts saturated delivery and included proxy/cleanup
failures; they are not passing graphics regression baselines.

The minimap retains current world marks and pilots. Its earlier player-only
work-count experiment is historical; no current frame-rate gain is claimed from
that simplification. Diagnostic DPR/glow controls remain opt-in, with no reduced
production graphics default accepted.

Numerical performance thresholds remain report-only in repository CI. Candidate
adoption decisions use their predeclared experiment criteria and preserve
failures. The [monthly review prompt](monthly-review-prompt.md) exists; this work
created no recurring automation.
