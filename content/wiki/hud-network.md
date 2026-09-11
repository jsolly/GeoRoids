---
title: HUD and the shared world
category: Systems
summary: Read lives, fuel, health, nearby threats, and scores. Understand what
  to do if the connection drops.
order: 150
related:
  - content/wiki/field-manual.md
  - content/wiki/controls.md
  - content/wiki/combat-survival.md
  - content/wiki/factions.md
media: []
---

## What the HUD shows

Before entering a game, set your pilot name, choose a kit, and use the Sound
checkbox on the title screen to enable or mute audio.

The HUD shows lives as kit hull icons, score, faction label and mark, kit name,
and a fuel bar. Desktop layouts include a leaderboard of up to 10 rows and a
minimap; touch layouts use a compact leaderboard and an adaptive minimap. The
minimap shows
your ship, other human pilots, bot pilots, asteroids, loot drops, hostile
satellites, loose pickups, and orbiting pickups inside the arena ring. Compact
marks follow each entity's current position; destroyed or collected objects
disappear when the shared state removes them. Slate squares mark asteroids;
cream squares and diamonds mark wreckage and shards, green crosses mark fuel,
yellow slashed diamonds mark laser cores, purple crosses mark satellites, and
amber circles and diamonds mark loose and orbiting pickups. Ship headings and
faction marks keep pilots identifiable above the world marks. Kill and pickup
messages appear in the center for 120 frames, or 2 seconds. A health capsule appears
above a damaged ship; use its remaining fill to judge hull health. Your own
hull is mint, other human pilots are sky blue, and bots are orange. Faction
marks identify allies separately from those colors.

## Display refresh rate

Flight, projectiles, shields, and HUD message timers advance at the shared
simulation rate. A faster display does not increase ship speed or shorten
cooldowns. After a visible stall, the client catches up only within its
bounded simulation window; switching back from a hidden tab instead resumes
from current server state.

## Connection interruptions

Keep the game tab up to date. If the server asks you to update the client,
reload the page before joining again. Older game versions cannot join.

Switching away from the game releases held movement and fire controls. On
return, the client requests current server state and resumes drawing without
replaying the time the tab was hidden.

The game automatically tries to reconnect after a lost connection. During an
interruption, the local view may lag behind the shared world; wait for the
connection to recover before relying on a pickup or hit result. If joining
fails or reconnect attempts are exhausted, the game returns to the title
screen. Select Enter Game to try again. A full reload can start a new session,
so it is not a way to preserve a life.
