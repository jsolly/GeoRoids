# Belt passes per frame

The 60 Hz loop owes the awake asteroid belt a fixed number of walks. Two of
them are structural; everything else must reach its rocks directly.

| Pass | Owner | Why it walks everything |
| --- | --- | --- |
| Motion | `AsteroidManager.updateMotion` | Every awake rock steps position, rotation and boost. |
| Belt crawlers | `BeltCrawlerManager.advance` | Finds hosts carrying crawlers or in a crawler slot. |

`tests/unit/server/boosted-cargo-reaches-a-furnace-without-a-second-belt-walk.test.ts`
counts the walks and the whole-belt copies a frame makes, using
`tests/support/beltTraversalInstrumentation.ts`. A third full-belt walk in
`advanceOneFrame`, or any `getAllAsteroids()` call inside it, fails that test.

Note the scope. `AsteroidManager` holds only the rocks in awake sectors, so a
belt walk is local work that grows with nearby pilots, not with the saved
world; `tests/unit/server/crew-resumes-a-persistent-open-world.test.ts` pins
that bound. The cost removed below was redundancy on top of a mandatory pass,
not a walk over the stored world.

## What changed

`tickAbilities` and `processFurnaceDeliveries` each called
`AsteroidManager.getAllAsteroids()` — `Array.from(this.asteroids.values())` —
every frame, then used the copy at one place apiece: a filter for
`boost.phase === 'armed'` and one for `'burning'`. A frame cost four belt
walks and two throwaway belt-sized arrays to service a case that is normally
empty. It now costs two walks and no copies.

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
one of them fails it.

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

## Known remaining pass

`BeltCrawlerManager.advance` walks `spatialIndex().values()` every frame, in
`advanceSpiderField`, to find hosts where `beltCrawlerIds` is set or the
deterministic belt slot is a multiple of six. Both are knowable at admission,
so the same tracked-set treatment would fit, with `initializeHost` and crawler
damage as the announcement points. It is left alone deliberately: it is a
separate state machine with its own test surface, and the guard above pins it
at one pass so it cannot grow unnoticed.
