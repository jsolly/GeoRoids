# Preparing snapshot validators once

The client trace attributed about 414 ms sampled self CPU to snapshot field
validation during its 30-second measured phase. Every validated object rebuilt
the same array of field names and validator functions with `Object.entries`.

The candidate creates that array when each private schema is defined. Every
snapshot still runs the same validators in the same order. Required fields,
optional fields, enumeration checks and cross-entity references are unchanged.
Unknown JSON fields remain preserved by the codec. The optimization applies to
both server snapshot capture and client decoding.

## Comparison

The Node 24.16.0 fixture contains ten pilots, 80 asteroids, loot, satellites,
pickups and changing projectile/tag collections. It uses 180 distinct world
states, repeated with fresh decoders. Each observation warms 540 frames and
measures 1,800 frames. Three unchanged A/A pairs and three alternating A/B pairs
run sequentially on the local Apple silicon Mac.

| Phase | Original median total | Candidate median total | Median paired reduction | Largest A/A difference |
| --- | ---: | ---: | ---: | ---: |
| Validate 1,800 worlds | 129.92 ms | 65.20 ms | 50.06% | 0.46 ms |
| Parse and decode 1,800 frames | 530.28 ms | 401.02 ms | 24.17% | 8.23 ms |

The parse/decode arm uses the real decoder, with keyframes, deltas, retained
baselines and JSON parsing inside the timed region. Encoding and fixture
construction happen before timing. The candidate and control protocol sources
are identical except for which validator they import. These are Node phase
measurements, not browser rendering, phone FPS or server capacity results.

## Correctness

The comparison checks 3,002 worlds and mutations across 166 field paths:
692 accepted and 2,310 rejected by both validators. It compares direct validation
and keyframe decode results, including exact error names/messages and input
mutation checks. Cases include missing fields, wrong types, nonfinite values,
optional motion/upgrade fields, reflection energy and cross-entity references.
Both decoders also reconstruct the same 180-frame stream, for 360 exact decoded
world comparisons.

No validation or copy is removed. The schema objects are private constants and
are not mutated after construction; retained entries are bounded by that fixed
schema set. The Wiki's rules and demonstrations are unchanged.

Independent review accepted the source, exactness and timing evidence. The
combined candidate passed 61 focused scenarios, desktop/mobile gameplay and Wiki
browser checks, TypeScript, lint and the full repository gate.

## Evidence

The [receipt](snapshot-validation-receipt.json) identifies the measured source,
control, harness and raw samples under `.performance/snapshot-validation/`.
From `/Users/johnsolly/code/GeoRoids-worktrees/mobile-performance-and-pace`:

```sh
node --import tsx .performance/snapshot-validation/compare.ts
```

Add `--timing` only on an otherwise idle benchmark host. The scratch script writes
fixed output paths, so preserve the existing files before reproducing results.
