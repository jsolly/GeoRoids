---
title: Loot and growth
category: Systems
summary: Collect loot for mass and score, or shoot a drop to push nearby small rocks.
order: 80
related:
  - content/wiki/hauler.md
  - content/wiki/asteroids.md
  - content/wiki/satellites.md
  - content/wiki/combat-survival.md
media:
  - heading: Shoot a drop
    demo: loot
---

## Loot and mass

Growth uses the same base health curve for every kit. When a pickup raises
maximum health, it adds the same amount to current health; it does not fully
repair existing damage. For a heavy kit such as Hauler, the first small mass
pickup can lower its starting maximum health to the shared growth value.
Laser cores do not add mass. Hull draw size and collision radius stay at the
kit base; collecting does not enlarge the silhouette.

Asteroid breaks can release shards, and an environmental ship death releases
wreckage. A Resource Tap ejects cream canisters with amber tips in spaced bursts during
extraction; the asteroid stays intact. The full reward is split across the
canisters, and each one can be collected separately. That Tap loot is not a diamond chip. A death converts a base amount plus a fraction of the destroyed
ship's excess mass into pellets, subject to per-pellet and global limits. Loot
expires after its configured lifetime. A nearby drop is pulled toward a living
ship once it comes within magnet range. Tap canisters use a stronger pull when
a Hauler is nearby. The pull adds to whatever motion the
drop already has, including motion from its existing velocity. Collecting still
happens when the drop overlaps the kit hull, not an inflated ship hitbox.
Mass follows a shared growth curve:
greater mass raises health capacity while reducing thrust and speed;
the growth model soft-caps mass and enforces minimum thrust
and speed scales. Death resets the growth.

A shard has a score value. A reflective core grants stronger laser charges with
energy 2, scores when collected, expires after a timed lifetime, and is cleared
on death. The shared reflection rules cap laser energy; enhanced energy also
lets a laser apply the metal hit twice.

## Shoot a drop

A laser can detonate a nearby loot drop when the shooter is within its arm
range. The drop is removed and its shot-triggered blast is safe for every crew
hull, including the shooter and teammates. It adds an outward velocity impulse
to small asteroids. A rock is affected when its edge reaches the blast radius;
the blast does not deal ship damage or consume a life.
