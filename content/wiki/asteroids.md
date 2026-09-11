---
title: Asteroids
category: Arena
summary: Asteroid material, size, shooter history, and reflection state
  determine damage, splits, rewards, and projectile behavior.
order: 90
related:
  - content/wiki/fuel-growth.md
  - content/wiki/factions.md
  - content/wiki/combat-survival.md
media:
  - heading: Cooperative splits and score
    demo: split
  - heading: Reflection and charge
    demo: reflection
---

## Field and materials

The server seeds the moving asteroid field with a starting population inside a
configured field radius. Surviving rocks and fragments stay in the field;
splitting can raise the count above the starting population. With a human
pilot present and the game running, the server reseeds only when no rocks
remain. Ice and rubble are lower-health materials; metal is tougher and needs
repeated normal laser hits. Metal shards carry more mass than ice and rubble
shards.

Rubble can fragment into three uneven pieces when it breaks above size 20.
Those fragments are below size 20 and do not multiply again. Ship collisions
destroy an asteroid without using the laser split path. The asteroid cap is 200
rocks, so a split can be suppressed when the cap is reached.

## Cooperative splits and score

A cooperative split sends two outward pushes through nearby ships and rocks: a
fast wave arrives first, followed by a heavier wave. The force weakens with
distance and pushes smaller bodies harder. These waves change motion without
dealing direct damage; an ally can still be shoved toward a hazard.

For ice and ordinary rocks, the large-rock collaboration rule begins at the
large-size threshold. Two distinct shooter IDs that hit the same biggest-class
rock inside the collaboration window produce two fragments at 60 percent of
the original size and a radial collaboration shockwave. A second hit from the
same shooter destroys the rock without a collaboration split; same-shooter
echoes inside the deduplication window are ignored. If nobody lands a
qualifying second hit before the window expires, the tagged rock breaks
automatically without splitting. Metal instead takes three normal hits and does
not break just from waiting; rubble uses its own fragment rule. Medium and
small rocks do not use the collaboration rule.

Asteroid score is based on the rock size at the break. A collision break does
not award the collaboration split behavior.

## Reflection and charge

Reflective metal clusters use the actual polygon faces for laser reflection. A
cluster rock can absorb a finite energy charge. Each hit adds the incoming shot
energy to the rock's charge; a reflected shot multiplies its own energy up to
the configured cap. Reflection stops when the rock fills its charge, the laser
reaches its energy cap, or the shot reaches the bounce limit; the laser also
has a lifetime cap. A rock that reaches its terminal reflection state breaks
and can release the core reward. Reflected projectiles keep their speed
magnitude and can damage the originating pilot or a same-faction pilot, while
direct shots keep the friendly-fire faction filter.
