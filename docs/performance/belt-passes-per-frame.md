# Belt passes per frame

The 60 Hz loop owes the awake asteroid belt a fixed number of walks. Two of
them are structural; everything else must reach its rocks directly.

The 60 Hz loop walks the awake asteroid belt exactly once, in
`AsteroidManager.updateMotion`, because every awake rock steps its position,
rotation and boost each frame. Nothing else may walk it: every other concern
is rare enough to reach its own rocks directly.

`tests/unit/server/the-frame-walks-the-asteroid-belt-once.test.ts` counts the
walks and the whole-belt copies a frame makes, using
`tests/support/beltTraversalInstrumentation.ts`. A second full-belt walk in
`advanceOneFrame`, or any `getAllAsteroids()` call inside it, fails that test.

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

Each of those five points has a mutation check in the guard test; dropping any
one of them fails it. The crawler set is maintained at the same points, by the
same rule.

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
