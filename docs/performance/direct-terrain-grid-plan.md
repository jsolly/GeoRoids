# Direct terrain grid implementation plan

Status: implemented with exactness checks and calibrated production measurements.
See [results](direct-terrain-grid-results.md) for the narrower measured benefit.
Publication requires the full shipping gate and independent release verification.

## Outcome and scope

Build the same local terrain patches with less synchronous CPU work. When a
pilot enters a new area or Mineral Scan needs wider coverage, terrain generation
should leave more time for rendering and input. Reduced visible stuttering is a
possible benefit to measure, not an established result.

Implement only the direct numeric grid in the existing TypeScript terrain
pipeline. The experiment measured 33.48% less normal-patch CPU and 26.71% less
scan-sized-kernel CPU, including contour extraction and spatial indexing. These
are targets to recheck after integration, not promised whole-game gains.

Work begins on `codex/direct-terrain-grid`, from fetched `origin/main` at
`5cdaeedad8db22f5925dd4cdc176caa606bfc5be`. No worker, spider optimization,
language rewrite, renderer migration, protocol change, terrain-quality change,
or production operation is included.

## Current flow and chosen design

`terrainSession.ts` selects a bounded patch and calls `extractIsoContours`, then
builds its spatial index. `extractIsoContours` currently calls `sampleHeight`
for every point in a regular grid. Each call repeats coordinate setup, noise
lattice/fade calculations and warped-passage trigonometry that depend on only
one row or column. The existing nine-patch cache already limits retained regions.

Keep that flow, its synchronous API, patch ownership and marching-squares order.
Add one grid operation beside point sampling in `heightfield.ts`:

```ts
createHeightGrid(field, gridSize, bounds)
// returns { heights: Float64Array, minH: number, maxH: number }
```

Bounds derive from the existing heightfield center/radius shape. Callers provide
the same field, grid size and bounds they already use. Grid preparation computes
field-relative axis coordinates, octave lattice indices/fades, and passage
offset/width values once per row or column. A row-major numeric loop produces
the complete Float64 grid and extrema. `extractIsoContours` consumes this result
instead of its current point-sampling loop; subsequent marching stays intact.

Fresh arrays belong to one job. At grid 96, the experimental axis buffers total
17,072 bytes alongside the existing 75,272-byte height grid. Preserve bounded
storage proportional to grid size; do not retain new caches or buffers on the
heightfield, scan the saved world, or add disk work.

### Rule ownership

- `heightfield.ts` owns noise interpolation, octave parameters, landmark
  contributions, spawn flattening, rim fading and final height composition.
  Point sampling and grid sampling share these canonical arithmetic primitives.
  Prepare octave frequencies/amplitudes in their original operation order and
  avoid per-point objects, callbacks or Maps in the grid path.
- `passages.ts` owns seed phase, wave offset/width, radial envelope and band
  strength. Expose the small primitives needed by grid preparation; reuse them
  in existing point/passage sampling rather than duplicating constants or rules.
- `contours.ts` owns level selection, marching, clipping and ordered segment
  output. Change only height-grid construction and its import.
- `terrainSession.ts`, physics callers and renderers retain their current APIs
  and lifecycle. Scalar sampling and gradients remain correct for arbitrary
  points, not just grid locations.

Preserve exact arithmetic order. In particular, keep `Math.hypot` where the
original uses it, preserve origin-plus-index multiplication before subtracting
the field center, and retain Float64 values, signed zero and strict boundary
comparisons. Do not copy the experimental kernel wholesale into production.

The chosen design shares arithmetic while keeping axis preparation specialized.
A copied independent kernel would duplicate gameplay rules. Per-point lookup
caches and sampling callbacks add overhead; the earlier Map variants lost or
were inconsistent. Offloading changes scheduling and latency and belongs to a
separate decision.

## Execution sequence

1. **Freeze the reference.** Retain the pinned baseline's complete terrain
   dependency graph, including heightfield, passages, configuration and contours.
   Generate a small set of ordered numeric contour fixtures before refactoring.
   Record the revision and source hashes; do not use a mutable current module as
   the old reference.
2. **Integrate the grid.** Extract shared arithmetic primitives, add bounded
   numeric axis preparation and the row-major grid loop, and migrate contour
   extraction. Remove its superseded sampling loop. Keep the normal production
   entry point, without an experimental toggle or parallel runtime kernel.
3. **Prove equivalence.** Add one focused grid scenario test; retain existing
   contour, passage, travel and camera-cache tests. Compare complete Float64 bytes
   and exact extrema against real point sampling, and independently compare
   point/gradient and ordered contour outputs against the pinned old reference.
4. **Remeasure the actual implementation.** Adapt the source-bound experiment
   harness under `benchmarks/` to compare the frozen baseline with the production
   entry point. Include setup, complete extraction and a fresh real spatial
   index in each call. Keep immutable fields outside both timers. Retain the
   rerunnable harness, every raw sample, identities and cleanup receipts.
5. **Review docs and validate.** Review Terrain and Scout Wiki text and their
   demonstration rules. Exact output should require no article/media change;
   record that conclusion and accept only the changed source hashes using the
   documented scoped review command. Run the complete `npm run gate`, including
   unit, integration, frame-work and constrained-client lanes. Have an independent
   critic inspect the actual diff, equivalence results and timing receipts.

Run all test and measurement sequences serially from
`/Users/johnsolly/.codex/worktrees/da50/GeoRoids`. Integration services always
belong to `scripts/test-runner.sh`; never attach to another checkout or kill its
listeners. Update the progress receipt as each stage completes.

## Verification and acceptance

The correctness matrix covers seeds 42, the default seed and 123456789, normal
patches, neighboring patches, wider scan-sized kernels, generated landmark
centers, axis/diagonal rim intersections, translated worlds, fractional bounds,
a small grid, eager small-world extraction and fully outside-world patches.
Rim and landmark fixtures must actually exercise the named geometry.

Every grid height and extrema must agree exactly. Ordered contour fixtures must
encode every level and endpoint without rounding, sorting or JSON signed-zero
loss. Four ordered spatial-query comparisons verify the complete indexed output.
Existing gameplay/browser checks cover contour travel, turning, scan coverage
and patch reuse. Capture native rendered evidence and console/network failures
for the affected flows; output equality alone is not a smoother-frame claim.

Reproduce the prior 21-case browser job cohort in fresh contexts on the same
native host with CPU slowdown 4: ten warmups and twelve measured calls per arm,
three A/A pairs before, three alternating A/B pairs, then three A/A pairs after.
Measure both normal and scan-sized groups. Each qualifying case must save more
than its maximum bracketing control drift in every A/B pair. Seek the prior
17/18 normal and 3/3 scan qualification coverage, positive group savings and no
reproducible regression; preserve noisy cases and failures. The 4096-radius
cases remain scan-sized kernels until mapped to an actual viewport.

No elapsed-time assertions go into unit tests. Desktop throttling is not a
physical-phone result. Do not claim higher FPS, better slow-link freshness,
lower battery use or fewer visible stalls without their own measured evidence.

Acceptance requires exact behavior, complete cleanup, a passing full repository
gate, a fresh critic pass and a measured production-job benefit beyond controls.
If arithmetic sharing erases the gain, fix its measured cost and remeasure; do
not keep formula duplication or weaken correctness/noise checks to pass.

## Delivery and release boundary

Deliver the scoped source/test/Wiki-review diff with a results document that
records what changed, actual checks, benchmark limits and remaining uncertainty.
Preserve raw evidence outside the removable worktree. One implementation PR covers the migration; no staged rollout is needed.

The user subsequently approved implementation and `/ship`. Complete full
semantic review, the local gate, PR CI and merge, then independently verify the
client and any required server release with the canonical production smoke.
Preserve evidence and retire the owned worktree after verification succeeds.
Reverting the optimization needs no saved-world or wire-format migration.
