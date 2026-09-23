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
  - content/wiki/terrain.md
media:
  - heading: Damage and protection
    demo: survival
---

## Firing while moving

Shots leave the nose and inherit your ship's velocity, so a moving ship
changes their flight path. Hold fire to repeat shots at your kit's interval.
The local shot field has a cap for regular shots. The slower movement leaves shots in flight longer while
firing cadence and this cap stay fixed, so a full rack can remain occupied for
more real time. A regular shot mines an asteroid by the configured laser amount; reflected or
core-powered shots multiply that damage by their energy. Loose satellite
pickups are invulnerable and shots pass through them. Equipped satellites
can be damaged by asteroid impacts and ricochets. Direct lasers never damage a
crew hull. After a bounce off the arena wall or a
reflective asteroid or court reflector, the shot becomes a ricochet: it damages any live ship
it then hits, including its owner, and is consumed. Bounced bolts use the
danger color so a live ricochet is readable. Local shots appear immediately
and stay visible while the server confirms them; the server still controls
hits and removal.
Shots also damage and kill terrain spiders without changing your firing limits.

## Ricochet Court

Meet at the Ricochet Court northeast of Town Square for informal duels. There
is one permanent court, marked on both maps even before you explore it. Four
angled cyan energy panels provide bank shots with open approaches between them.
Ships fly straight through the panels without collision damage. Lasers reflect
from either side at the same angle they arrive, keeping their speed and energy.
The panels cannot be mined or destroyed and do not award laser cores.

Aim at a panel to bank a shot toward another pilot. Direct shots still pass
harmlessly through ships; after a bank, the shot can damage any unprotected
hull, including your own. Existing protection, damage, lives, and respawn rules
still apply. There is no matchmaking or separate duel score. Shots can leave
the court through its gaps, so watch for stray ricochets when passing nearby.

## Damage and protection

Normal lasers, asteroid impacts, and boundary impacts use different damage
rules. A ship-to-asteroid impact removes 25 health. A towed ordinary asteroid
that hits
another ship uses that same impact and then breaks, dropping the Hauler cable.
A towed colossal deposit deals that impact without breaking. Unbounced ship
lasers, ship-to-ship ramming, the Hauler tow cable, and a
shot-triggered loot blast never damage a crew hull. A bounced laser deals the
configured laser hit times its energy and is consumed on the first live hull it
meets. The boundary destroys a vulnerable ship on contact, even at full health;
asteroids bounce back into the world. Untowed asteroids pass through each other;
only towed cargo turns an asteroid-to-asteroid overlap into a collision break.
A colossal deposit survives that break and leaves the other rock destroyed.
While the universe map or ship schematic is open, asteroid impacts, ricochets,
and the boundary pass through the held hull. Closing the overlay grants the same
blink window as a respawn.

Terrain spiders mostly guard resource territories, with larger groups around more valuable finds. Guards chase briefly before returning home; rare roaming hunters pursue farther. Both kill with one bite on contact, regardless of remaining health. Their bites obey spawn protection, overlay immunity, and life-loss rules. See [terrain spiders](/wiki/#terrain) for warnings, escape behavior, and how to fight them.

## Lives and respawn

A player starts with lives and score. A death decrements one life; the last life
reaching zero enters game over. Explosion stops active thrust and turning; held
controls resume when the server confirms your respawn. Respawn restores the
kit's health, resets mass growth, clears upgrade state, and grants temporary
spawn protection. Closing the universe map or ship schematic grants that same
blink window, because rocks can occupy the hull while it is held. Respawns use the nearest lit hearth to the death location, 180
world units from its center at a random angle. Dark street foundations are not respawn sites.

After game over, a fresh flight starts with 3 lives and score 0. A brief
disconnect still returns you to the same ship; a long absence does not.
The persistent universe, shared exploration chart, and delivered
progress stay until the expedition is reset.

Health regenerates after a real-damage delay. Score survives a respawn.
Wreckage is emitted from a destroyed ship. The visible death message includes
the recorded environmental cause (an asteroid, the arena wall, a ricochet, or a terrain spider),
and the final-life state shows the game-over overlay.

## Score values

Asteroid breaks, shard pickups, satellite pickups, and furnace deliveries each
award their own score value. A furnace delivery pays the Hauler and every
Surveyor recorded on the rock. A pilot who built streets receives more on their
own payout.
