---
title: Satellites and pickups
category: Arena
summary: Six Earth-observation satellite pickups glow in the shared field and
  enter ship inventory for temporary asteroid scanning.
order: 110
related:
  - content/wiki/teamwork.md
  - content/wiki/loot-growth.md
  - content/wiki/combat-survival.md
  - content/wiki/hud-network.md
media:
  - heading: Six Earth-observation hulls
    demo: satellites
  - heading: Equipped satellites
    demo: pickups
---

## Six Earth-observation hulls

The field uses six collectible Earth-observation satellite hulls. Each has a
distinct silhouette so you can tell Landsat 7, Terra, Aqua, GOES-16, ENVISAT,
and WorldView-3 apart at a glance. They are passive hardware pickups: they do
not fire or damage a ship on contact.

## Shared pickup rules

The field holds a limited number of loose satellite pickups. They spawn
separately from asteroid destruction, stay stationary, and glow to mark them as
collectible hardware. Loose pickups cannot lose health. The
nearest living player within collection range claims a loose pickup
automatically and earns a score bonus. Collection does not grant a combat
ability or spawn protection.

## Inventory

Collected hardware enters the collecting ship's inventory. Both Surveyors and
Haulers open the ship schematic with V or by pressing and holding their own
hull on touch. Stored satellites do not orbit or lose health. A brief notification names the
satellite you acquired. The inventory lists its health and estimated flight
time without further damage.

## Equipped satellites

Choose Equip in the schematic to deploy one stored satellite. Only one can
orbit your ship at a time; the other satellites stay in storage. Equipping
does not replace your ship's E ability or the Hauler's selected utility.

The equipped satellite automatically identifies nearby asteroids for the crew.
Their mineral markers remain identified after the satellite is gone. Scanning
also contributes to the shared exploration chart and records the pilot for
shared asteroid rewards. Satellite range is shorter than the Surveyor's core
scan, so a Hauler gains local identification without the Surveyor's long-range
ability. A Surveyor can use a satellite between its own scan pulses.

Health and remaining lifetime are the same resource. A full-health satellite
lasts two minutes while equipped. Its health drains steadily with time, and
asteroid impacts or ricocheting shots remove health immediately, shortening
that lifetime. Ordinary crew shots pass through owned satellites.

Equipped satellites stop glowing and show the same thin green health bar as
ships once health starts draining. There is no separate countdown ring. The
schematic derives its remaining-time estimate from health. At zero health the
satellite disappears from your inventory and orbit, then respawns healthy as a
loose pickup after a recovery delay.

It cannot be unequipped to save health or replaced while still active. Opening
the schematic holds your ship stationary. The world keeps running: your ship
can still take damage, and the satellite keeps orbiting, scanning, and losing
health.

Death or explicitly leaving the game drops both stored and equipped hardware
at the ship's last position. A brief connection loss preserves ownership during
reconnect grace; exceeding that grace drops the hardware. Dropped hardware stays stationary and glows again. It cannot take damage
until equipped again, and keeps its remaining health. After a drop, a
reconnect does not reserve that hardware; another pilot may collect them. Ship
inventory is temporary and does not survive a server restart.

## Satellite audio

Equipping a satellite plays a short crystal confirmation. While it orbits your
ship, a soft chime sounds once per orbit, with silence between passes. The
chime moves with the satellite and gently changes pitch. Headphones make its direction clearest. The sound stops when the satellite leaves orbit or breaks, and
when you turn Sound Effects off or leave the game tab. Music off does not stop
the chime. Other pilots' satellites do not add
extra orbit chimes.
