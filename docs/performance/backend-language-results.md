# Backend language experiment

Keep Node for the current collision API. The optimized C++ kernel saves about
30% in isolation, but the tested Node-API binding is 12.6 times slower once each
call reads ordinary JavaScript asteroid records and constructs JavaScript
results. Tiny numeric differences are acceptable; this integration cost is not.

The kernel uses cached polygons, swept bounds and hash-based ID membership.
Its compute gain remains valid, but would require a different integration
boundary to help the backend. A separate Node square-root experiment preserved
hit decisions but produced no repeatable saving beyond control noise.

## Why this kernel

The actual server profile identified polygon preparation and edge intersection
as substantial costs. The [collision report](asteroid-collision-work-results.md)
records that profile and the resulting 68.9% reduction in fixed-tick server CPU.
The language experiment ports that actual geometry code, including reflection,
corner rules, nearest-ID ties, work limits and validation.

The prototype uses the installed Apple Clang compiler with C++20, `-O3`,
`-ffp-contract=off` and `-fno-fast-math`. No package, compiler toolchain,
runtime subscription or production dependency was added. The scratch binding
uses the installed Node headers. The product server remains TypeScript on Node.

## Numeric behavior

The corpus has 150 cases: the snapshot fixture's actual asteroid shapes and
seeded shots, plus flat/rotated faces, corners, concavity, inside/departure paths,
grazing, near-parallel rays, ignored origins, reflections and malformed inputs.
The binary fixture preserves double precision and UTF-16 IDs for JavaScript's
lexical tie ordering.

All 150 cases match structurally, including hit/no-hit, selected ID/edge,
termination and error messages. All 24 malformed-input errors match. Of 715
numeric fields, 586 are bit exact and 129 differ. The largest absolute difference
is `4.547473508864641e-13`; the largest relative difference is about `1.08e-13`.
Twenty-six distance fields differ numerically. These are accepted as negligible
under the user's stated preference for speed over identical floating-point bits.
This small corpus is not a long-running gameplay-equivalence proof.

## Repeated timing

Timing excludes the 24 malformed cases and repeatedly executes the remaining
126 valid cases. Each arm warms 30 corpus iterations and measures 500 iterations,
or 63,000 case executions. Five batches rotate original Node, optimized Node and
native order. Each batch includes a second unchanged original-Node control.
Unexpected errors in valid cases fail the run. Every arm consumes the same
result fields; their final scalar sums match.

| Implementation | Median kernel time for 63,000 cases |
| --- | ---: |
| Original Node | 2095.21 ms |
| Unchanged Node control | 2089.03 ms |
| Direct C++ port of original algorithm | 1438.80 ms |
| Optimized Node with cache and bounds | 310.80 ms |

The median paired native reduction versus original Node is 31.42%; the optimized
Node reduction is 85.22%. The largest A/A difference is 21.05 ms, much smaller
than either saving. These are elapsed wall times of synchronous work, not OS CPU-counter readings.
The fixed-pose repetitions favor geometry reuse; the
separate evolving `GameEngine` comparison includes moving asteroids and measures
the smaller 68.9% whole-tick reduction.

Native fixture decoding takes a median 1.34 ms. Its entire process takes a median
1529.14 ms, including startup, decoding, warmup, measured work and shutdown.
Subtracting kernel time would not isolate an FFI or startup cost. Node fixture
decoding and module initialization are recorded separately in the raw report.

## Cache and hash-membership comparisons

The second C++ implementation adds the same polygon cache and swept AABB checks
as current Node. It preserves the original native sources and results. All 150
structural cases and all three calls in the live pose/offset mutation probe
match, with the same negligible numeric differences described above.

Its first run measured 731.57 ms versus 308.29 ms for optimized Node. That C++
version still used an ordered `std::set` and copied IDs while checking uniqueness.
The JavaScript implementation uses a hash set. A third native variant replaces
only that membership operation with a reserved `unordered_set<u16string_view>`.
The borrowed views exist only during the query; the fixture owns their strings.

The final comparison adds an adjacent unchanged optimized-Node control as well
as the original-Node control. Five batches rotate implementation order, with
30 warmup and 500 measured iterations over the same 126 valid cases per arm.
Every batch validates both A/A sums exactly and checks cross-language sums within
`1e-6` absolute or `1e-15` relative tolerance. All checks pass.

| Implementation | Median kernel time for 63,000 cases |
| --- | ---: |
| Original Node | 2104.55 ms |
| Original Node control | 2094.90 ms |
| Optimized Node | 304.72 ms |
| Optimized Node control | 317.28 ms |
| Direct original C++ | 1453.79 ms |
| Cached C++ with hash membership | 213.98 ms |

The median paired reduction versus optimized Node is 29.98%. Every pair saves
29.56–33.64%. The largest optimized-Node A/A difference is 16.46 ms, below the
roughly 90 ms paired saving. The earlier run without that matching control is
retained separately and does not replace this evidence.

This native cache assumes stable object ownership during a fixture. The corpus
uses fixed shapes for repeated queries, and its absorption callback is static.
It does not include the separate 96,120-case extreme-coordinate false-hit probe.
Those limits matter before any integration into a moving authoritative world.

## JavaScript conversion boundary

The scratch Node-API addon accepts the current nearest-impact arguments: start,
end, an array of ordinary asteroid records and an optional ignored ID. Every
call reads those JavaScript fields, copies the native geometry, updates its
cache, executes the kernel and constructs a JavaScript result. No preloaded
fixture handle bypasses conversion. Native instance data owns its copied
records and finalizes the cache when the environment closes. Resizing storage
clears address-based cache entries first.

All 132 nearest corpus cases match structurally, including 16 malformed errors.
Three further in-place pose/offset cases match. Of 545 numeric fields, 127
differ, with maximum absolute error `4.55e-13`. The other 18 corpus cases use
preview/reflection APIs that this binding does not expose.

Five alternating batches each contain an adjacent Node A/A control and the
native binding. Each arm warms 30 iterations and measures 500 iterations of
116 valid nearest cases, or 58,000 measured calls.

| Implementation | Median time for 58,000 calls |
| --- | ---: |
| Current optimized Node | 325.07 ms |
| Unchanged Node control | 324.45 ms |
| Native binding, including conversion | 3987.13 ms |

The median paired native/Node ratio is 12.61. Every pair is 11.07–12.99 times
slower. One Node control takes 538.95 ms versus its paired 325.07 ms. That
213.88 ms A/A outlier is retained and is much smaller than the roughly 3.6-second
binding regression. All final consumed result sums match.

The native arm owns one cache context per arm. Switching fixture groups can
invalidate its current storage, while Node's WeakMap can retain multiple object
groups. This is a limitation of the tested binding design, not a fair claim
about every possible native cache. A batched boundary or native-owned simulation
could amortize conversion; neither was measured here. The result rejects this
per-query drop-in binding.

## Decision and remaining scope

Retain Node. The tested bounded
square-root replacement had no reliable advantage over Math.hypot in Node, despite
45,350 structurally matching queries/previews/corpus cases and negligible numeric
drift. The direct binding also regresses sharply. A whole-backend rewrite cannot
be justified by the kernel percentage alone.

No batched native boundary, full-server port, deployment or capacity staircase was measured.
None of these timings is phone FPS evidence. Independent reviews accepted the covered original-port, cached-native and
hash-membership behavior and scoped timing claims. Independent review also accepted rejection of the arithmetic candidate
because its measured change was within unchanged-control noise.
Independent review accepted rejection of the per-query binding, including the
conversion boundary, cache limitations and retained A/A outlier.

## Evidence and reproduction

The [receipt](backend-language-receipt.json) records the source, fixture, raw
correctness fields, timing samples and compiler provenance under
`.performance/backend-language/native/`. The first timing invocation lacked the
script's executable bit; that failed log is retained, followed by a passing
explicit Bash invocation. The bounded timing smoke is separate from the final
500-iteration comparison.

From `/Users/johnsolly/code/GeoRoids-worktrees/mobile-performance-and-pace`, on an
otherwise idle benchmark host:

```sh
bash .performance/backend-language/native/run-timing.sh \
  --warmup 30 --iterations 500 --batches 5 \
  --report .performance/backend-language/native/timing-recheck.json
```

The wrapper regenerates the fixture and recompiles the native harness. Preserve
original artifacts before rerunning. Independent review accepted the source, raw results and scoped conclusion. A
fresh compile/correctness pass after the timing-wrapper edits reproduced the
same results. Earlier auxiliary checksums remain in the preserved pre-wrapper
folder; current auxiliary metadata is refreshed. This scratch prototype is not
part of the production build.

The controlled hash-membership comparison can be reproduced from the same
working directory after compiling its helper:

```sh
bash .performance/backend-language/native/hash-membership/run-timing.sh \
  --warmup 30 --iterations 500 --batches 5 \
  --report .performance/backend-language/native/hash-membership/timing-recheck.json
```

That wrapper now selects `timing-with-optimized-control.ts`. The original
`timing.ts` and both earlier reports remain retained. The final controlled
report records its exact adapter and binary hashes.
