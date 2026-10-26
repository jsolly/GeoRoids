# Belt passes per frame

An ordinary 60 Hz frame walks the awake asteroid belt exactly once, in
`AsteroidManager.updateMotion`, because every awake rock steps its position,
rotation and boost each frame. Nothing else may walk it per frame: every other
concern is rare enough to reach its own rocks directly.

One frame in sixty costs more, on the cadence AGENTS.md sanctions for work
leaving the loop. Two blocks land on it together:

| Block | Belt copies | Where |
| --- | --- | --- |
| `ensureAsteroidField` | 3 | one in `RegionalAsteroidField.update`, two in `sleepDistantSectors` |
| `checkpointWorld` | 4 | two in `RegionalAsteroidField.checkpoint`, two in `sleepDistantSectors` |

So that frame costs **7 belt copies and 8 passes in production**, and 3 copies
in a fixture with no `WorldPersistence`, because `checkpointWorld` returns
early without one. Both numbers are pinned, each against the world shape that
reaches it: an earlier version of this note claimed only the first three, and
the guard could not see the rest because its world had no persistence.

`tests/unit/server/the-frame-walks-the-asteroid-belt-once.test.ts` counts the
walks and the whole-belt copies a frame makes, using
`tests/support/beltTraversalInstrumentation.ts`. A second full-belt walk in an
ordinary frame, any `getAllAsteroids()` call inside one, or a changed copy
count on the once-a-second frame all fail that test. It measures a whole
second in both world shapes, so the sector frame cannot hide a new per-frame
pass, and it counts the rows the frame reaches **through the tracked sets** as
well, so a set that quietly grows to belt size is not invisible.

Note the scope. `AsteroidManager` holds only the rocks in awake sectors, so a
belt walk is local work that grows with nearby pilots, not with the saved
world; `tests/unit/server/crew-resumes-a-persistent-open-world.test.ts` pins
that bound. The cost removed below was redundancy on top of a mandatory pass,
not a walk over the stored world.

## What changed: boosted cargo

`tickAbilities` and `processFurnaceDeliveries` each called
`AsteroidManager.getAllAsteroids()` — `Array.from(this.asteroids.values())` —
every frame, then used the copy at one place apiece: a filter for
`boost.phase === 'armed'` and one for `'burning'`. A frame cost two belt walks
and two throwaway belt-sized arrays to service a case that is normally empty.

`AsteroidManager` tracks the ids of rocks carrying a boost and exposes them as
`boostedAsteroids()`. Both consumers read that instead of the belt.

## Why a tracked set is safe here

`boost` is written in several places, including `shared/shipAbilities.ts`,
which reaches a rock as a plain body and has no manager to tell. A set that
could miss a burning rock would silently stop furnace deliveries, so the set
is deliberately a **superset**: it may name a rock whose boost was since
cleared, and `boostedAsteroids()` prunes those as it yields. Only a missing
entry is a defect, and each way a boost can appear has a home:

- **Admitted mid-burn** — a saved world, a supply shipment or a split arrives
  with `boost` already set. `addAsteroid` notes it. This is what the roughly
  25 standalone `processFurnaceDeliveries()` call sites in
  `tests/unit/server/` depend on: they never run a motion pass.
- **Armed or ignited in place** — `shared/shipAbilities.ts` writes `boost`
  onto a live row. Its one production caller is `GameEngine.useAbility`, which
  calls `noteBoost` for the rock just latched and the one left burning. This
  mirrors `refile`, the manager's existing convention for geometry written in
  place.
- **Edited through the manager** — `updateAsteroid` notes it.
- **Anything else** — `updateMotion` already reads every rock's boost to tick
  it, so it adds untracked ones for free. A future write that forgets to
  announce itself costs one frame of delay rather than a lost delivery.

Removals need no announcement: they only make the set a larger superset.

The crawler set is maintained at the same points, from the rock's id and
`beltCrawlerIds`. Two of its points deserve naming:

- `updateAsteroid` keeps both sets because it applies an arbitrary row patch;
  no caller passes `boost` or `beltCrawlerIds` through it today, but a method
  taking `Partial<AsteroidData>` has to stay right for the one that does.
- The crawler half of the `updateMotion` backstop is **not** redundant with
  admission, and its comment says so. A crawler transferring onto a non-native
  rock is written straight onto that row by `BeltCrawlerManager.transfer`, and
  nothing announces it. Drop that line and the rock is never named again once
  a population-limit dip drops its body — `setPopulationLimit` runs every
  frame while a cooperative campaign is active — so the crawler is silently
  lost while its row still carries a live wound.

### What the guard rejects

Measured by deleting each line on its own and running the guard, rather than
reasoned about. Do not restate this as a count; a count is what drifted twice
before. Each row is the case whose failure you will see.

| Maintenance point | Rejected by |
| --- | --- |
| `addAsteroid` boost add | a rock admitted mid-burn |
| `addAsteroid` crawler add | a belt crawler on its native slot |
| `updateAsteroid` → `noteBoost` | a boost set through the manager |
| `updateAsteroid` crawler add | a combat frame reaches a crawler host |
| `removeAsteroid` `boosted.delete` | a delivered rock stops costing |
| `removeAsteroid` `crawlerHosts.delete` | a belt four times larger |
| `updateMotion` boost backstop | a boost written straight onto a tracked row |
| `updateMotion` crawler backstop | crawler rows written straight onto a tracked row |
| `GameEngine.useAbility`'s `noteBoost` | an owner dies; a belt four times larger |
| `hostsToVisit`'s body union | a migrant keeps crawling (crawler suite) |
| weakening: boost add made unconditional | a belt four times larger |
| weakening: `hostsBeltCrawlers` always true | a belt four times larger |

The last two matter because they are how a set grows without any line being
deleted. They are caught because the instrumentation counts the ids each
tracked-set read **considers**, not the rows it yields: a stale id is pruned
before it is yielded, so counting yields would have missed exactly the growth
that makes these sets cheaper than the walk.

### What the guard does not reject

| Point | Why |
| --- | --- |
| `boostedAsteroids`' prune | masked by `removeAsteroid`'s delete; the pair is rejected, neither half alone |
| `crawlerHostAsteroids`' prune | masked the same way by `removeAsteroid`'s crawler delete |
| `noteBoost`'s `else` delete | the superset tolerates the stale id until the next read prunes it |
| `clearAsteroids`' two clears | reached only by a world reset, never from a frame |

These are superset-shrinking hygiene: dropping one cannot lose a game action,
because the invariant is that only a *missing* entry is a defect. What they
protect is the bound, and the masking is why a pair test rather than a line
test is what pins it.

## Obstacles that shaped this

Two designs were tried first and rejected.

**Collecting boosted rocks during the existing motion pass** looked free,
since that pass already calls `tickAsteroidBoost` on every rock. It fails on
both consumers rather than one. `tickAbilities` runs *before* `updateMotion`
in `advanceOneFrameInternal`, so it would read a one-frame-stale list, and
`advanceCombatFrame` skips `updateMotion` entirely to drive death and respawn
without moving the belt. `processFurnaceDeliveries` runs after the motion pass
but is called on its own by scenario tests, which would then see no list at
all. A set maintained at each mutation point has no frame ordering to get
wrong, which is why it replaced the per-frame collection.

**Inverting the burning scan onto the furnaces** — query rocks near each
furnace instead of filtering the belt — would need no new invariant, because
the spatial index is already maintained. It was rejected because frontier
furnaces and civic modules accumulate as a world is settled, so the work would
grow with world progress, and `FurnaceField` exposes no bounded enumeration.

## What changed: belt crawlers

`BeltCrawlerManager.advance` walked `spatialIndex().values()` every frame, in
`advanceSpiderField`, to find hosts where `beltCrawlerIds` was set or the
deterministic belt slot was a multiple of six. The caller now selects those
hosts and passes them in, from a second tracked set on `AsteroidManager`.

Membership follows the rock's id and `beltCrawlerIds`, neither of which motion
changes, so the set is settled at admission and never re-derived per frame.
That matters: the slot test is a regex on the id, and running it for every
awake rock on every frame was part of the cost.

`shared/beltCrawler.ts` now owns the rule as `hostsBeltCrawlers`, with the
stride named `BELT_CRAWLER.NATIVE_SLOT_STRIDE`. It had been an unnamed `% 6`
in two places.

The one way a rock becomes a host out of band is a crawler transferring onto
it — `transfer` calls `initializeHost` on a destination found by a local
spatial query. That needs no announcement: the transferred body is in
`this.bodies`, so `advance` visits the caller's candidates **plus the rocks its
own bodies sit on**. The crawler manager keeps that invariant to itself
instead of pushing a notification contract onto its caller.

Order is preserved. The set is keyed by id and `Set` iteration follows
insertion order, which matches the belt map's, and body hosts are appended.
Appending cannot change which crawlers get created at
`BELT_CRAWLER.MAX_ACTIVE`, because a transferred crawler already has its body;
the population limit only gates creating one.
`campaign-spiders-share-reserved-population.test.ts` covers that limit.

## Still open

The once-a-second frame's 7 copies hold the remaining duplication.
`RegionalAsteroidField.update` scans for `boost?.phase === 'burning' || probe`
and `sleepDistantSectors` scans again for `probe`; `checkpoint` scans a third
time for `burning` alone, which `boostedAsteroids()` would answer directly.
The probe half would want its own tracked set, and the two sector partitions
need a full walk by nature.

It is left alone: once a second is a twentieth of a per-frame cost, it is a
different module, and the guard above pins both counts so neither can grow
quietly.

Also deferred, with reasons:

- `BeltCrawlerManager.hostsToVisit` reads `body.host` directly where the
  module's other reads go through the injected live-host resolver. It dedupes
  by id with the caller's rows first, so a live row always wins over a stale
  one, and `advance` already drops bodies whose host is missing or dead.
- `crawlerHostAsteroids` copies its id set before yielding, and its one
  consumer drains it immediately — a second copy of a small set. The copy
  stays because it makes the walk safe to prune during, which the two prune
  rows above depend on.
- `AdvanceOptions.hosts` is one-directional and enforced nowhere. Extra rows
  are harmless, because `advance` re-checks `hostsBeltCrawlers`. An
  under-supplied list is not: a native-slot rock whose body does not yet exist
  would never spawn its crawler, and nothing would detect it.
- The instrumentation installs its wrappers on the manager instance, not on
  `AsteroidManager.prototype`, so a throw part-way through installation leaves
  one dead engine's own properties patched rather than the shared prototype.
