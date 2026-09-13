# Avoiding repeated asteroid polygon work

The September 12 server profile found repeated polygon preparation and edge
testing in the authoritative laser path. `asteroidPolygonPoints` accounted for
about 650 ms sampled self CPU and `polygonImpact` for 489 ms, out of a 2,082 ms
profile. That justified an algorithm change before a backend language rewrite.

The candidate keeps each live asteroid's private polygon until its position,
rotation, size, vertex count or radial offsets change. It compares offset values,
so mutating the existing offsets array invalidates the entry. Removed asteroid
objects can be collected through the WeakMap. Public polygon arrays remain
independent and mutable by their callers.

After validating every obstacle, the query rejects polygon bounds that cannot
intersect the swept segment's padded bounds. Padding retains the existing
edge/corner tolerance and allows for coordinate rounding. The existing exact
intersection, normal, nearest-hit and tie-breaking code handles the remaining
polygons. Invalid off-path geometry still throws.

## Measured server work

Three A/A controls and three alternating A/B comparisons execute the real
`GameEngine` and `GameStateBroadcaster`. Each fresh process uses seed 42,
300 warmup ticks and 600 measured ticks, with periodic broadcasts every second
tick. The initial world had 10 human participants, two bots, 80 asteroids,
six hostile satellites and two pickups. Human pilots offer regular shots while the
ordinary bot, collision, asteroid, death and respawn paths advance. That fixture
predates the pickup-only satellite roster.

During measurement, all ten participants remain present, seven to ten are alive,
59–71 asteroids remain and 25–75 player projectiles are active. Every human has
accepted measured shots. Humans do not send movement commands in this fixture.
The immediate transport sink excludes socket scheduling and network drain;
these results do not establish server capacity or phone FPS.

| Metric | Original median total | Candidate median total | Result |
| --- | ---: | ---: | --- |
| 600 simulated ticks | 1727.71 ms | 539.72 ms | 68.86% median paired CPU reduction |
| 300 periodic broadcasts | 345.26 ms | 341.16 ms | No reliable improvement claimed |

The tick saving exceeds the largest A/A absolute difference of 18.47 ms.
Broadcast changes are noisy, including a slower candidate pair, and are not
attributed to the collision change. Phase wrappers add measurement overhead;
the same wrappers and serializer execute in both arms. Event work invoked within
a tick remains included in that tick. Nested phase totals must not be added.

All twelve runs produce identical normalized initial and final game-state
hashes. Normalization replaces opaque UUID substrings; it preserves ordered
world values. The comparison changes only `shared/asteroidReflection.ts` and
restores the candidate after each batch script completes.

## Geometry verification

The original and candidate match exactly for 44,000 collision queries, including
22,178 hits, and 1,200 multi-bounce previews. The corpus uses the snapshot
fixture's 80 asteroid shapes, short and long shots, ignored-origin IDs, varied
world coordinates, concave contours, small polygons and
nearly parallel rays. Numeric fields are compared exactly, without a tolerance.

All 16 focused reflection scenarios pass, including the later extreme-coordinate
regression described below. They include flat faces, corner
bisectors, exits from inside, shallow crossings, grazing, absorbing surfaces,
nearest-ID ties, invalid geometry and work limits. The added scenario mutates
the same asteroid object between shots, edits exported polygon points and then
makes off-path geometry invalid.

A separate targeted probe found 376 differences across 96,120 nearly parallel,
near-endpoint queries against polygons of size 900,000 or 999,999. In these
cases the original narrow phase reported a hit outside the polygon because
cross-product cancellation amplified rounding error; the candidate correctly
rejects the disjoint bounds. The raw failing exact-equality probe is retained.
A focused regression now protects the first false-hit case. Exact equality is
therefore limited to the ordinary corpus above, not the entire accepted numeric
domain. The user explicitly accepts small differences when performance improves;
this correction is retained under a gameplay-behavior bar.

The Wiki's reflection and terrain rules are unchanged. Combined desktop/mobile
browser checks, 61 focused scenarios, TypeScript, lint and the full repository
gate passed. The later false-hit regression passed all 16 reflection scenarios
and scoped lint. Independent review accepted the gameplay-behavior bar after inspecting the
extreme false-hit witnesses; the earlier strict-equality failure is retained. The native collision prototype compares against this optimized Node
implementation as well as the original algorithm; its result must not be
confused with a full backend port.

## Evidence

The [receipt](asteroid-collision-work-receipt.json) records raw reports, source,
test and comparison hashes. Local ignored artifacts are in
`.performance/reflection-cache/` and `.performance/backend-language/`.
From `/Users/johnsolly/code/GeoRoids-worktrees/mobile-performance-and-pace`:

```sh
node --import tsx .performance/reflection-cache/verify.ts
python3 .performance/reflection-cache/compare-server.py
```

The comparison temporarily selects each reflection implementation. It requires
exclusive source ownership and a quiet benchmark host. Failed scratch preflight
logs are retained separately: the first had an argument mismatch in the phase
wrapper; the corrected preflight and subsequent measurements passed.
