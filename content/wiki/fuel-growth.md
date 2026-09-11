---
title: Fuel, loot, and growth
category: Systems
summary: Fuel powers Quake's shock pulse. Collect loot to grow, or shoot a drop
  to create a dangerous blast.
order: 80
related:
  - content/wiki/quake.md
  - content/wiki/hauler.md
  - content/wiki/asteroids.md
  - content/wiki/satellites.md
  - content/wiki/combat-survival.md
media:
  - heading: Shoot a drop
    demo: loot
---

## Fuel

Every kit starts a life with fuel and has a fixed fuel maximum. An asteroid
above the fuel-drop size threshold can drop a fuel pickup. A pilot at full fuel
cannot collect it. Quake E is refused when the tank cannot pay its cost.

## Loot and mass

Growth uses the same base health curve for every kit. When a pickup raises
maximum health, it adds the same amount to current health; it does not fully
repair existing damage. For a heavy kit such as Hauler, the first small mass
pickup can lower its starting maximum health to the shared growth value. Fuel
and laser cores do not add mass.

Asteroid breaks can release shards, and a ship kill releases wreckage. A kill
converts a base amount plus a fraction of the destroyed ship's excess mass into
pellets, subject to per-pellet and global limits. Loot expires after its
configured lifetime. Mass follows a shared growth curve: greater mass raises
radius and health capacity while reducing thrust and speed; the growth model
soft-caps mass, caps size scaling, and enforces minimum thrust and speed scales.
Death resets the growth.

A shard has a score value. A reflective core grants stronger laser charges with
energy 2, scores when collected, expires after a timed lifetime, and is cleared
on death. The shared reflection rules cap laser energy; enhanced energy also
lets a laser apply the metal hit twice.

## Shoot a drop

A laser can detonate a nearby loot drop when the shooter is within its arm
range. The drop is removed and the blast reaches nearby live hulls, including
the shooter and allies. It bypasses both E and F shields; spawn protection
blocks it. It adds an outward velocity impulse to small asteroids. A hull or
rock is affected when its edge reaches the blast radius.
