---
title: HUD and the shared world
category: Systems
summary: Read lives, health, the local radar, the universe map, and scores. Understand what
  to do if the connection drops.
order: 150
related:
  - content/wiki/field-manual.md
  - content/wiki/controls.md
  - content/wiki/combat-survival.md
  - content/wiki/teamwork.md
media: []
---

## What the HUD shows

Before entering a game, set your pilot name, choose a kit, and use the Sound
checkbox on the title screen to enable or mute audio. Muting stops sounds already
playing too. Starting with Sound off skips loading sound files. When you enable
audio, effects become available as they load; missed sounds do not play later.

Shots, impacts, and explosions vary their pitch slightly each time they
start, keeping repeated actions from sounding identical. Automatic thrust is silent. Nearby action is louder; off-screen combat
cues stay silent. Tow cables have attach and release cues. Orbital pickup
and pickup-break sounds differ from ship lasers. Laser cores and
material pickups have separate cues, as do kit abilities and respawning.

The HUD shows lives as kit hull icons, score, kit name, and the current ability.
Desktop layouts include a leaderboard of every active player row and a
local minimap; touch layouts use a compact leaderboard and an adaptive local
minimap. The local minimap follows the ship's nearby radar: it shows your ship,
other players, explored asteroids, loot drops, loose satellite
pickups, and orbiting pickups. Unexplored positions remain under fog. Compact
marks follow each entity's current position; destroyed or collected objects
disappear when the shared state removes them. Slate squares mark asteroids;
cream squares and diamonds mark wreckage and shards, larger cream canisters
with amber tips mark Tap loot, yellow slashed diamonds
mark laser cores, and lilac circles and diamonds mark loose and orbiting
satellite pickups. Ship headings and kit colors keep pilots identifiable above
the world marks. Completed sectors are hatched on both maps. Crossing into a
new open sector shows a brief HUD notice with that sector's coordinates. Press
V or hold your own Hauler hull to open the local ship schematic.
M or use the Map button to open the full-screen universe
map. It uses the crew's shared exploration chart and keeps discovered furnaces
and other important assets visible across the large world, even when they are
outside the local radar. A discovered furnace stays marked in the local radar
while it is within that nearby view; the universe map keeps its exact landmark
when it is farther away. Death, delivery, and pickup
messages appear in the center for 120 frames, or 2 seconds. On touch screens,
they sit below the top HUD so they do not cover the leaderboard. A health capsule
appears above a damaged ship; use its remaining fill to judge hull health.
Every active pilot stays on the leaderboard so the
crew can see shared asteroid work and delivery points.

## Display refresh rate

Flight, projectiles, abilities, exploration, and HUD message timers advance at the shared
simulation rate. A faster display does not increase ship speed or shorten
cooldowns. After a visible stall, the client catches up only within its
bounded simulation window; switching back from a hidden tab instead resumes
from current server state.

If your predicted flight drifts beyond the server's movement limits, your ship
returns to its last accepted position and resumes flight there. This correction
keeps the visible ship, shots, and asteroid impacts in the same place. A brief
network stall that delivers up to about one second of held position reports all
at once is not a drift, and neither is a pause on the server itself: the time
the server spent unable to read your reports is credited in full, those reports
are accepted, and your ship stays where you flew it.

## Connection interruptions

Keep the game tab up to date. If the server asks you to update the client,
reload the page before joining again. Older game versions cannot join. The
browser and server remember which game versions issued this tab's resume token
and last saved its score, and when those writes happened, so a later update can
migrate that progress instead of guessing. A score saved while you are offline,
or when the UTC month resets, records the server version without a client
version.

Switching away from the game releases held movement and fire controls. On
return, the client requests current server state and resumes drawing without
replaying the time the tab was hidden.

The game automatically tries to reconnect after a lost connection. During an
interruption, the local view may lag behind the shared world; wait for the
connection to recover before relying on a pickup or hit result. If joining
fails or reconnect attempts are exhausted, the game returns to the title
screen. Select Enter Game to try again. Reloading the page continues this
browser's current score if you still have lives. A brief disconnect, including
a quick return from the title screen, puts you back on the same ship. After
about 30 seconds away, Enter Game starts a new flight with that score instead of
the old location. After game over, Enter Game starts at score 0. You can change
your nickname on the title screen before Enter Game.
The playfield stays on the title screen until the server acknowledges join and
sends the first world snapshot.

## Surveyor scan

The local minimap and full-screen universe map use one persistent shared
exploration chart. Passive Surveyor reveal reaches 650 world units and passive
Hauler reveal reaches 260; every crew member contributes to the same
explored area. Pilots stay readable; discovered furnaces remain marked on the
universe map, while uncharted asteroid, loot, and furnace positions stay hidden.
Open the universe map with M or the Map button, then close it with M, Escape,
or the Close control.

Press E or tap Scan to identify nearby asteroid minerals on every teammate's
radar. An active scan reaches 1,200 world units around its Surveyor. Ice becomes
a circle, metal a square, and rubble a triangle; the legend labels each shape.
The classification remains visible for that rock while it is in the nearby
radar, even after the active scan ends. Unscanned rocks remain ordinary dots.
The Surveyor's scan also records its player ID on the rock for a later furnace
delivery.
