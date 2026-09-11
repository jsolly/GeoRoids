---
title: Damage, scoring, and survival
category: Combat
summary: Know what each shield stops, how much a hit costs, and what you keep
  when you respawn.
order: 130
related:
  - content/wiki/controls.md
  - content/wiki/factions.md
  - content/wiki/fuel-growth.md
  - content/wiki/satellites.md
  - content/wiki/hud-network.md
media:
  - heading: Damage and protection
    demo: shield
---

## Firing while moving

Shots leave the nose and inherit your ship's velocity, so a moving ship
changes their flight path. Hold fire to repeat shots at your kit's interval.
The local shot field has a cap for regular shots; the Skirmisher's E ring does
not count against it. A regular shot deals the configured laser damage;
reflected or core-powered shots multiply that damage by their energy. Local
shots appear immediately and stay visible while the server confirms them; the
server still controls hits and removal.

## Damage and protection

Normal lasers, player collisions, asteroid impacts, boundary impacts, and
exploding loot use different damage rules. The regular F shield reflects hostile lasers
and does not stop environmental collisions. Warden F lasts longer; its E
projects a reflective shield to a nearby ally. Both reflect hostile lasers
without stopping collisions. Exploding loot bypasses both
shields and can hurt allies and the shooter. Spawn protection blocks that
blast too.

## Lives and respawn

A human starts with lives and score. A death decrements one life; the last life
reaching zero enters game over. Explosion stops active thrust and turning; held
controls resume when the server confirms your respawn. Respawn restores the
kit's health, resets mass growth, clears shield and upgrade state, restores
fuel, and grants temporary spawn protection. Human respawns are placed within
80 percent of the asteroid field radius; bots always respawn.

Health regenerates after a real-damage delay. Score survives a respawn. Kill
loot is emitted from the destroyed ship. The visible death message includes
the recorded death cause, and the final-life state shows the game-over overlay.

## Score values

Human kills, bot kills, satellites, asteroid breaks, shard pickups, and
satellite pickups each award their own score value.
