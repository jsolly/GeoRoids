# Deterministic frame work results

Repeated timing comparisons are still required to establish a frame-pacing gain.
These observations establish reduced work in a controlled scene, not phone FPS.

## Contour spatial culling

Two independent observations per arm ran the same seeded portrait scene:
seed 42, DPR 1, 30 warmup frames, 120 measured frames, fixed simulation steps.
The only product difference was contour candidate selection. The original renderer
scanned every segment; the candidate uses cached spatial cells, then applies the
same transforms, clipping predicate, draw order and strokes.

| Metric | Before per frame | After per frame |
| --- | ---: | ---: |
| Contour endpoint reads | 101,416 | 1,388 |
| Reduction | | 100,028 reads, 98.63% |

All 120 work vectors repeated exactly within each arm. Every other measured work
metric, including Canvas calls, matched across arms. Initial/final game outcomes
and the final rendered-frame SHA-256 also matched. Pixel equality is limited to
the final controlled frame; moving-camera and crossing-line unit tests separately
check that candidate selection preserves the full scan's accepted segment order.

The optimization trades a cached spatial index for fewer repeated reads. It adds
no graphics degradation. Index construction occurs when terrain changes and is
outside the warmed steady-state counts. These counts do not include all engine
instructions or prove that allocation, memory, or elapsed CPU cost decreased.

The [work budget](frame-work-budget.json) uses 1,388 contour reads per frame as an
reference value for this fixture in behavioral CI. Exceeding it produces a
report entry and preserves the observed maximum, difference and affected frame count.
It emits no CI warning and does not block development. Adjust the budget after reviewing the feature
tradeoff; missing or invalid measurements remain errors. General timing budgets remain under
investigation. Use [the benchmark commands](../../benchmarks/README.md#deterministic-work-per-frame)
to reproduce observations and compare independent runs.

## Artifact receipt

Raw artifacts are local under `.performance/mobile/`. The comparison is
`contour-work-comparison.json`; each source records product, harness, source and
dependency hashes. Both arms used harness SHA-256
`06d5fafee1f7ec0f5dab8bfea93e0a8154233bd0f8cb603b251a046012b91f83`.

| Raw observation | SHA-256 |
| --- | --- |
| `work-final-baseline-1.json` | `ce795c903e03e5e2988c915424e7dac8b4414c9f97a7bd788f7b422a9dd74ec2` |
| `work-final-baseline-2.json` | `4ad79f1a6f9e6b28d9b5a665eb850a706f3a661e7388c8aea0238bf95781550d` |
| `work-final-candidate-1.json` | `d0aae20790893615744e53d0dbbf7ad6ed1c2f8bf5dce87098027e8cd56caa0a` |
| `work-final-candidate-2.json` | `65dc98e90cb6c625f979e284cc693ab5bfc83aec8d0e83a16756b430f8dc7129` |

## Verification checkpoint

The full repository gate passed after the work-count and contour changes. Six
browser tests passed across field-manual, phone-recording and touch-recovery
scenarios. A real 120-frame observation with a deliberately reduced 1,000-read
reference exited successfully with no warnings. Every frame recorded 1,388 reads.
The report `work-budget-report-only.json` retains the 388-read difference and all
120 exceeded frames. Earlier blocking/advisory artifacts remain historical only.
Focused tests also cover overruns, headroom and invalid measurements.

A separate CPU-profile smoke confirmed this host's headless Chromium uses
ANGLE SwiftShader with software Canvas rasterization and compositing. Repeated
timing sessions must keep that backend fixed and identify it as a software
rendering cohort. These results do not describe a native phone GPU. The profiling
run is excluded from performance comparisons.
