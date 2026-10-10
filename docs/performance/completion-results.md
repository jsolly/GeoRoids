# October 2 performance results

Canvas remains the default renderer. WebGL2 is available through
`?renderer=webgl2`, with performance explicitly unqualified. Production WebSocket
compression remains disabled. The user revised the stopping rule to completion
and diminishing returns; further blind retries on a heavily loaded host would
not establish a useful result.

## Implemented changes

- Reuse local contour paths and exploration decoding; skip clipped radar cells,
  unnecessary ordinary-loot motion queries and hidden furnace work. Retain
  bounded asteroid, loot and laser surfaces instead of creating replacements
  during every scan-resolution transition. HUD inset caching follows actual
  probe changes without repeated style reads on unchanged frames.
- Add an opt-in WebGL2 rear layer with retained resources, contour batches and
  explicit context/failure fallback. Preserve native star and thin-contour
  painting where required for the frozen quality contract. Keep native DPR and
  full glow in both renderers.
- Migrate active clients and servers together to snapshot v2: compact indexed
  collection patches, packed asteroid motion and incremental spider fields.
  Share detached immutable public snapshot parts within one synchronous
  broadcast after local interest and recipient privacy selection. Preserve
  bounded ACK credit, callback-owned baselines and recovery. Remove forced
  refreshes after 90 deltas; initial join and explicit recovery still use full
  worlds, and a smaller full representation can still be selected.
- Make measurements retain successfully applied worlds, actual frame/input
  work, native GPU identity, source/build hashes, whole-server CPU and real
  proxy transport-byte windows. Fix fixture provenance buffering and ACK
  settlement races exposed by the complete gate.

## What the evidence establishes

CPU preflights retained identical full-frame pixels and gameplay witnesses.
One stationary fixture reduced contour move/line submissions from 218 each per
frame to zero. A complete scan transition reduced those submissions from
700,585 to 78,293, with native stroke and sprite counts unchanged. Surface reuse
reduced 3,125 Canvas object creations to zero; all backing resets and repaint
work still occurred. These are structural work reductions, not calibrated
whole-app timing claims.

Packed predictive motion reduced downstream bytes by 52.08% and 51.14% against
the fixed-identity relative-v2 baseline. All 302 ordered decoded states and the
initial/final worlds matched exactly. This is a settled loopback byte
diagnostic, not sustained slow-link qualification.

Removing forced refreshes preserved all 302 ordered decoded states and 80
control/event packets in the matched real-socket stream. Downstream bytes fell
9.85% for the scanning pilot and 21.27% for the other pilot, with unchanged ACK
bytes. This isolates that refresh change in a four-second simulated window;
it does not qualify sustained throughput or responsive slow-link play. The
earlier v1/v2 comparison used different UUID ordering, so its larger diagnostic
byte estimate is not an exact ordered-state acceptance result.

The frozen composed matrix passed all 102 checkpoints across six desktop,
phone, tablet and fractional-DPR profiles. Native context loss, upload/blit
failure, hide/freeze/resume, socket recovery, touch controls and Wiki scenarios
passed without widening the pixel masks. Physical-phone frame rate, battery
and thermal behavior remain unmeasured.

Implementation commit `f60d8bc2c785478d47168ce629c94317e6afbf86` passed two complete
gates: 1,957 unit tests, 220 integration scenarios, frame-work budgets and both
constrained-client profiles. An earlier unchanged desktop audio scenario timed
out once; it subsequently passed unchanged in isolation and in both complete
integration runs. Its exact stalled await remains unproven.

## Unqualified candidates

Seven full six-minute Canvas sessions passed the renderer driver's validity
checks at 390×844, DPR3, CPU4, native/full quality, seed42 and the five-pilot
fixed combat fixture. Driver acceptance establishes retained functional and
measurement evidence; report-only performance overruns still require review.
The later Canvas sessions already had freshness stalls: `aa3-b` reached
2,133 ms applied age and a 1,814 ms delivery gap; `ab1-a` reached 328 ms and
392 ms. The third Canvas A/A pair also shifted render p95 from 3.4 to 5.3 ms.
These diagnostics expose instability before the GPU failure and cannot
establish a stable renderer comparison.

The first GPU arm failed after 25.34 foreground seconds, 1,380 real GPU frames
and 38 input-latency samples. Traffic slowed for the browser and peers; the
server's event-loop delay reached 7.94 seconds and its clock and CPU probes
timed out. Host load rose from 2.05 before the cohort to 36.98 after failure,
with other applications consuming several cores. Those two machine snapshots
are a strong confound, not temporal or causal proof. The partial GPU window
cannot be compared with the full Canvas windows as a speed result. The twelve
sessions, strict A/B verdict, workload review and desktop timing comparison
were not completed. GPU promotion remains blocked by missing evidence.

The fresh 60-second degraded transport pair also missed the 924.288 ms
freshness limit: worst applied ages were 1,935 ms uncompressed and 996 ms with
the 1 KiB compression candidate. Aggregate downstream rates were 616,872 and
333,401 bytes/s, while whole-server CPU was 46.71% and 64.82%. Different evolving
populations prevent a calibrated causal claim. Byte savings do not qualify
either candidate for responsive slow-link play. See
[the candidate record](snapshot-v2-compression-candidate.md).

## Closure and remaining decisions

No push, PR, deployment, production configuration or data change was performed.
The protocol migration requires matching independently verified client and
server releases plus a refresh window; see
[the release contract](../protocol/snapshot-v3.md).

Performance qualification can resume on a quiet host. Start with one short
matched Canvas/GPU diagnostic to investigate a repeated common stall; success
only justifies a fresh complete calibrated cohort, workload review and desktop
checks. Keep the current defaults until that evidence passes. The in-game Wiki
is current for the implemented behavior; this results document changes no
controls or gameplay guidance.

Private evidence is preserved outside the checkout in the
[archive manifest](/Users/johnsolly/.codex/visualizations/2026/10/02/01a0fc4f-e9b2-7c03-8e36-b572a38de96c/performance-evidence/final/conservative-close-20261002/incomplete-archive-manifest.json).
It maps 26,781 originals and 8.21 GB of logical content to 2,947 saved regular
files containing 1.56 GB; the archive totals 1.60 GB including its manifest.
Every mapped source and saved file passed SHA/size/ownership verification.
The manifest explicitly excludes 5,851 temporary/cache references and records
all seven successful Canvas screenshots; the failed GPU report declared none.
It also retains the complete passed gate's selected proof, both gate-run logs,
transport candidates, review notes and the revised stopping rule. Its
qualification remains incomplete, with no synthesized twelve-session manifest
or GPU comparison verdict. Use its original-to-saved mapping after checkout
removal; original receipt paths are not claimed reusable.

The earlier core archive remains separate and unchanged. The owning plan and
source homes are recorded in [the implementation plan](gpu-renderer-plan.md);
other unshipped worktrees remain separate and preserved.
