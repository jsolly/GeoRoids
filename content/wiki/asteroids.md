---
title: Asteroids
category: Arena
summary: Asteroid material, size, contributor history, and reflection state
  determine damage, splits, rewards, and projectile behavior.
order: 90
related:
  - content/wiki/loot-growth.md
  - content/wiki/teamwork.md
  - content/wiki/combat-survival.md
media:
  - heading: Cooperative splits and score
    demo: split
  - heading: Reflection and charge
    demo: reflection
---

## Field and materials

The server generates deterministic deposits in 2,000-unit sectors throughout
the 60,000-unit world. Fresh sectors have roughly four drifting rocks for each
stationary one. Drifters range from slow targets to fast-moving hazards.
Sectors near every active pilot are loaded while distant sectors sleep. Harvested sectors stay
harvested when the crew returns; traveling into a new region loads its saved
deposits without replenishing an emptied region. Ice and rubble are
lower-health materials; metal is tougher and needs repeated normal laser hits.
Metal shards carry more mass than ice and rubble shards.

Rubble can fragment into three uneven pieces when it breaks above size 20.
Those fragments are below size 20 and do not multiply again. Ship collisions
destroy an ordinary asteroid without using the laser split path. A towed
ordinary asteroid that overlaps another asteroid uses that same collision
break on both rocks and drops the Hauler cable. Splits and fragments
are part of the active sector's current population; sector loading does not
impose a global asteroid cap.

A rare colossal deposit appears in some sectors outside the launch
neighborhood. It is a stationary landmark far larger than the ordinary large
class. One Hauler cannot haul it or ignite a Boost Coupling on it. Two Tow
Cables, two armed couplings, or many laser hits are required before it
starts breaking up. A ram or a towed collision against another rock leaves
the colossal deposit intact and shoves the ship away; the other rock still
breaks. Whole-rock furnace delivery still works once a crew can move it.

## Self-powered rocks

A Hauler's [Boost Coupling](/wiki/#hauler) aims an asteroid at its nearest
furnace. The cream arrow means armed; cream/amber exhaust means autonomous
delivery is active. Powered sectors stay awake until delivery, even when nearby
pilots leave. Self-guided cargo passes through ships, rocks, and satellites.
It ignores weapons and blast impulses, and cannot be
scanned, tapped, towed, or coupled again. At intake it shatters in a red outline
with a short smoke poof and awards its
launchers and previously recorded Surveyors the delivery points.

## Cooperative splits and score

A cooperative split sends two outward pushes through nearby ships and rocks: a
fast wave arrives first, followed by a heavier wave. The force weakens with
distance and pushes smaller bodies harder. These waves change motion without
dealing direct damage; a teammate can still be shoved toward a hazard.

For ice and ordinary rocks, the large-rock collaboration rule begins at the
large-size threshold. Two distinct pilot IDs that hit the same biggest-class
ice rock inside the collaboration window produce two fragments at 60 percent
of the original size and a radial collaboration shockwave. Both contributors
receive the collaboration score, so the first qualifying hit is rewarded as
well as the second. A second hit from the same pilot destroys the rock without
a collaboration split; same-pilot echoes inside the deduplication window are
ignored. If nobody lands a qualifying second hit before the window expires, the
tagged rock breaks automatically without splitting. Metal instead takes three
normal hits and does not break just from waiting; rubble uses its own fragment
rule. Medium and small rocks do not use the collaboration rule.

Asteroid score is based on the rock size at the break. Every miner who damaged
that rock and every Surveyor who identified it receives the full mining reward,
including contributors who disconnected before the final hit. Chipped deposits
retain their contributor history with the saved world. A collision break does
not produce the collaboration split behavior. Towed ordinary cargo that hits
another
rock uses this collision break rather than the laser split path. A towed
colossal deposit survives and breaks the other rock.

## Reflection and charge

Reflective metal clusters use the actual polygon faces for laser reflection. A
cluster rock can absorb a finite energy charge. Each hit adds the incoming shot
energy to the rock's charge; a reflected shot multiplies its own energy up to
the configured cap. Reflection stops when the rock fills its charge, the laser
reaches its energy cap, or the shot reaches the bounce limit; the laser also
has a lifetime cap. A rock that reaches its terminal reflection state breaks
and can release the core reward. Reflected projectiles keep their speed
magnitude and remain a bounded asteroid interaction. Direct ship lasers mine
rocks and pass through crew hulls; after a bounce, the same shot becomes a
ricochet that damages any live ship it then hits.
Three stationary metal rocks form each tight pinball cluster with inward-facing
facets. Approach an entry gap from outside the pocket to chain ricochets; every
bounce raises the shot energy, so a good lane can charge several rocks before
the cap.
