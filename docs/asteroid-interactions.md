# Reflective asteroids and laser cores

Reflective metal clusters are part of the shared asteroid field. Fire normally
with **Space**; the ordinary controls remain available while a shot is in
flight. The passive HUD keeps the laser-core charge count visible when a core
upgrade is active. There is no asteroid selection or tool mode.

While a Hauler's combat harpoon is actively attached to an asteroid, that
asteroid passes through its Hauler without causing collision damage. Unrelated
asteroids and other pilots keep the normal collision rules. When the timer or
attachment ends, the harpooned asteroid collides normally again.

## Reflective clusters and laser cores

Flat, faceted metal clusters reflect shots from their actual polygon faces. Each
bounce increases the shot's energy and charges the rock it hits. A rock breaks
when its stored energy fills, or when a shot reaches its energy, bounce, or
lifetime limit. Reflection follows the server's authoritative collision result;
the client does not offer a selection-dependent path preview.

Reflected shots can hurt their shooter and faction mates. Ordinary direct shots
still respect friendly fire. A broken reflector leaves one laser core: collect
it for 150 points and six stronger shots, usable for 60 seconds. The upgrade
expires on death. Shots, damage, charge use, and collection belong to the shared
world, so reconnecting does not replay rewards.

## Multiplayer protocol

Every pilot uses snapshot v1 with `asteroidInteractions:1`, acknowledged by the
server with a private resume token. Unsupported clients cannot join. The server
owns projectile collisions, and clients render keyed projectile snapshots.
Reflective phenomena seed when a pilot enters an active world and remain until
that world ends. Resume tokens are private to the joined socket and never appear
in the common public world.

## Updating open clients

Published client releases automatically refresh open tabs after two matching
release checks, about 30–60 seconds for active tabs. The check uses the client
origin's `x-release-id`; the independently deployed Railway server does not
trigger reloads. A per-tab guard prevents repeated reloads if the edge still
serves a cached bundle. Tabs opened before this watcher was shipped need one
manual refresh.

Gameplay WebSocket URLs include `asteroidInteractions=1`. Older clients receive
HTTP 426 before the WebSocket opens and must refresh. The join message must also
contain both current capabilities. `/logs` is unaffected. Client and server are
deployed independently; verify each release ID and current multiplayer behavior.
