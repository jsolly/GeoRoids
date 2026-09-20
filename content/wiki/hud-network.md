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

## Probe beacons

A pulsing cyan ring around a rock's minimap mark identifies a live
[Survey Probe](/wiki/#surveyor). Follow that rock to survey more of the field.
On the playfield the small diamond has a green health bar and emits expanding
scan rings. Amber pulses warn that its battery is nearly empty.

## What the HUD shows

Before entering a game, set your pilot name, choose a kit, and use Sound
Effects, Music, and Haptics on the title screen. Sound Effects mutes cues already
playing; Music loops a quiet title bed and an in-game bed after Enter Game.
In-play danger can temporarily switch to a threat bed, then the playfield
loop returns. Music off silences every bed, including danger, without muting
cues. This browser remembers both audio checkboxes. Starting with Sound Effects
off skips loading effect files. When you enable effects, they become
available as they load; missed sounds do not play later.
The Haptics checkbox stays off until you turn it on, and this browser remembers
that choice. With Haptics on, your own shots, hull hits, deaths, Boost starts,
kit abilities, pickups, and furnace deliveries buzz the device. Crew action
around you does not. Haptics use the web Vibration API: many Android browsers
can vibrate, while iPhone browsers cannot. If this browser has no vibration
API, the checkbox stays off and explained, and turning it on does nothing.
Native apps can use richer haptic engines; this web client does not wrap a native
shell.

Open Advanced and enable Debug to show this browser's Player ID and page
session ID. The Player ID is the same `playerId` already written on join and
motion STATE records; it appears after Enter Game confirms the ship. Copy it
and send it to an agent so they can find this ship in production logs with
`@playerId:` plus that value. The page session ID matches `@sessionId:` on
forwarded client records. Debug stays off unless you turn it on; this browser
remembers the checkbox. It does not publish your nickname or resume token.
While Debug is on, a compact HUD stays on the playfield. Its **Copy diagnostics**
button copies the Player ID, current ship, connection, browser and release
details plus up to 80 recent client warnings,
errors and state records for a bug report. It excludes private resume credentials.
Successful copies show **Copied!** for three seconds. If copying fails, the button
says **Copy failed**. The HUD shows live FPS, ping, snapshot age, motion epoch,
world counts, and short client/server release IDs.
Use **Hide HUD** during play to collapse the health overlay without turning off
Debug. **Show HUD** brings it back. This browser remembers the HUD visibility
separately from the Debug checkbox.
The debug panel sits above the flight controls so Boost remains visible, and
the kit ability button stays fully on the playfield.
Those health lines stay on-screen only; they are not written to Railway.

Sounds share a soft crystal-synth palette and a common musical key. Shots are
short tuned plucks; asteroid destruction is a rounded impact with a gentle
crystal tail. Resource Tap ejections play lower notes, and successive material
pickups answer with a melody. Three quick pickups complete a short phrase;
longer streaks vary it, and a pause starts a fresh phrase. Automatic thrust is silent. Nearby action is louder; off-screen combat
cues stay silent. Nearby shots and asteroid breaks come from their direction
around your ship: left/right match the screen, and up/down become front/back.
Headphones give the clearest 3D effect; the game outputs spatial stereo rather
than dedicated surround channels. Tow cables have attach and release cues. Orbital pickup
and pickup-break sounds differ from ship lasers. Laser cores and
material pickups have separate voices, as do kit abilities and respawning.
Boost start and stop, hull damage, satellite equip, and opening or closing the
map and schematic have quiet feedback. Furnace rewards play a short resolving
phrase even when your contribution was made away from the delivery; game over
has a lower closing phrase. Steering, recharge, map movement and regeneration
stay silent. Your equipped satellite plays a soft chime once per orbit, with silence between passes; a permanent
connection failure sounds once. Changing ships on the title screen plays a
quiet selection note, and entering a flight plays a welcoming phrase once the
world is ready.

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
mark laser cores, lilac circles and diamonds mark loose and orbiting
satellite pickups, and amber hairline three-tongue campfires mark discovered furnaces.
Kit hull silhouettes in local and crew colors keep pilots
identifiable above the world marks. Completed sectors are hatched on both maps. Crossing into a
new open sector shows a brief HUD notice with that sector's coordinates. Press
V or hold your own Hauler hull to open the local ship schematic.
M or use the Map button to open the full-screen universe
map. It uses the crew's shared exploration chart and keeps discovered furnaces
and other important assets visible across the large world, even when they are
outside the local radar. A discovered furnace stays marked in the local radar
while it is within that nearby view. On the universe map, furnace marks keep
the same zoom scale as satellites, wreckage, laser cores, and ships. Zoomed out,
they are amber flame pins; the nearby view and closer keep the three-tongue
campfire. Death, delivery, and pickup
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
at once is not a drift, and neither is a stall in the server's own game loop:
that stalled time is credited to your next report, those reports are accepted,
and your ship stays where you flew it.

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
Open the universe map with M or the Map button. It starts with a nearby view
centered on your current ship; zoom out to see distant discoveries or use the
locate control on the map to restore the nearby scale. Ships on both the local
radar and the chart use each pilot's hull silhouette. Close it with M, Escape, or
the Close control.
On touch, Map and Close hide keyboard badges.

Press E or tap Scan to identify nearby asteroid minerals on every teammate's
radar. An active scan reaches 1,200 world units around its Surveyor. Ice becomes
a circle, metal a square, and rubble a triangle; the legend labels each shape.
The classification remains visible for that rock while it is in the nearby
radar, even after the active scan ends. Unscanned rocks remain ordinary dots.
The Surveyor's scan also records its player ID on the rock for a later furnace
delivery.
