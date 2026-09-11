---
title: Satellites and pickups
category: Arena
summary: Six hostile satellite profiles patrol the shared field, while Echo and
  Relay pickups become durable orbiting interceptors.
order: 110
related:
  - content/wiki/factions.md
  - content/wiki/fuel-growth.md
  - content/wiki/combat-survival.md
  - content/wiki/hud-network.md
media:
  - heading: Six hostile profiles
    demo: satellites
  - heading: Echo and Relay pickups
    demo: pickups
---

## Six hostile profiles

The field uses several hostile Earth-observation satellite profiles. Each has a
distinct firing pattern, cadence, and projectile speed, so learn the visual
rhythm before crossing an exposed lane.

## Shared satellite rules

Ambient satellites have finite health, award points when destroyed, and deal
collision damage; satellite lasers deal normal per-hit damage and have a finite
lifetime. Both laser shields and spawn protection block these shots. Satellites
are hostile to every faction. They orbit and drift on the shared patrol path,
are repositioned when too far from living targets, and stay within the
configured satellite boundary. A destroyed satellite runs an explosion and
respawns after its configured delay.

## Echo and Relay pickups

The field can hold a limited number of loose satellite pickups. Echo and Relay
are spawned separately from satellite destruction and drift inside the pickup
field. The nearest living human within collection range claims a loose pickup
automatically and earns a score bonus. Collection does not grant a shield or
spawn protection.

Collected hardware orbits its owner indefinitely, staying outside the hull.
It has its own health and intercepts hostile player and bot shots, satellite
lasers, and asteroid collisions. Damage reduces its health; at zero it breaks
and respawns healthy as a loose pickup after its recovery delay. Owner death
or leaving releases it at its current position without restoring health.
Collection is shared, so two pilots cannot both claim one pickup.
