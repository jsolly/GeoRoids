---
title: Damage, scoring, and survival
category: Combat
summary: Know what reaches a ship, how much a hit costs, and what you keep when
  you respawn.
order: 130
related:
  - content/wiki/controls.md
  - content/wiki/teamwork.md
  - content/wiki/loot-growth.md
  - content/wiki/satellites.md
  - content/wiki/hud-network.md
media:
  - heading: Damage and protection
    demo: survival
---

## Firing while moving

Shots leave the nose and inherit your ship's velocity, so a moving ship
changes their flight path. Hold fire to repeat shots at your kit's interval.
The local shot field has a cap for regular shots. The slower movement leaves shots in flight longer while
firing cadence and this cap stay fixed, so a full rack can remain occupied for
more real time. A regular shot mines an asteroid or damages an orbiting
satellite pickup by the configured laser amount; reflected or core-powered
shots multiply that damage by their energy. Lasers never target or damage a
crew hull. Local shots appear immediately and stay visible while the server
confirms them; the server still controls hits and removal.

## Damage and protection

Normal lasers, asteroid impacts, and boundary impacts use different damage
rules. A ship-to-asteroid impact removes 25 health. Ship lasers, ship-to-ship
ramming, the Hauler tow cable, and a shot-triggered loot blast never damage a
crew hull, including after a laser ricochets off the boundary. The boundary
destroys a vulnerable ship on contact, even at full health; asteroids bounce
back into the world.

## Lives and respawn

A human starts with lives and score. A death decrements one life; the last life
reaching zero enters game over. Explosion stops active thrust and turning; held
controls resume when the server confirms your respawn. Respawn restores the
kit's health, resets mass growth, clears upgrade state, and grants temporary
spawn protection. Human and bot respawns use the same placement rule: the
nearest furnace to the death location, 180 world units from its center at a
random angle.

After game over, a fresh run starts with 3 lives and 0 score. The persistent
universe, shared exploration chart, and delivered progress remain available.

Health regenerates after a real-damage delay. Score survives a respawn.
Wreckage is emitted from a destroyed ship. The visible death message includes
the recorded environmental cause, and the final-life state shows the game-over
overlay.

## Score values

Asteroid breaks, shard pickups, satellite pickups, and furnace deliveries each
award their own score value. A furnace delivery gives the Hauler and every
Surveyor recorded on the rock the same delivery points.
