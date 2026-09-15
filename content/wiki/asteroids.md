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
the 60,000-unit world. A sector has 24 deposit slots, and sectors near every
active pilot are loaded while distant sectors sleep. Harvested sectors stay
harvested when the crew returns; traveling into a new region loads its saved
deposits without replenishing an emptied region. Ice and rubble are
lower-health materials; metal is tougher and needs repeated normal laser hits.
Metal shards carry more mass than ice and rubble shards.

Rubble can fragment into three uneven pieces when it breaks above size 20.
Those fragments are below size 20 and do not multiply again. Ship collisions
destroy an asteroid without using the laser split path. Splits and fragments
are part of the active sector's current population; sector loading does not
impose a global asteroid cap.

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
not produce the collaboration split behavior.

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
