# Reflective asteroids and laser cores

Reflective metal clusters are part of the shared asteroid field. Fire normally
with **Space**; the ordinary controls remain available while a shot is in
flight. The passive HUD keeps the laser-core charge count visible when a core
upgrade is active. There is no asteroid selection or tool mode.

A Hauler presses **E** to attach to a nearby asteroid and tows it at the cable's
original length. Press **E** again to release it. Attached cargo cannot damage its
Hauler or be destroyed by crew lasers. Other asteroids remain dangerous; crew
ships can overlap safely. Tow surveyed cargo into a furnace to award the Hauler
and each contributing Surveyor the same delivery points.

## Reflective clusters and laser cores

Flat, faceted metal clusters reflect shots from their actual polygon faces. Each
bounce increases the shot's energy and charges the rock it hits. A rock breaks
when its stored energy fills, or when a shot reaches its energy, bounce, or
lifetime limit. Reflection follows the server's authoritative collision result;
the client does not offer a selection-dependent path preview.

Direct crew shots leave every crew ship unharmed, including
the shooter. After a bounce off a wall or reflective face, the same shot
becomes a ricochet that damages any hull it then hits and is consumed. A broken reflector leaves one laser core: collect
it for 150 points and six stronger shots, usable for 60 seconds. The upgrade
expires on death. Shots, damage, charge use, and collection belong to the shared
world, so reconnecting does not replay rewards.

## Multiplayer protocol

Every pilot uses snapshot v1 with `asteroidInteractions:1`, acknowledged by the
server with a private resume token. Unsupported clients cannot join. The server
owns projectile collisions, and clients render keyed projectile snapshots.
Reflective phenomena are generated with each world sector and persist with its
deposits during the current UTC month. Private resume tokens recover a
browser's current score across disconnects and server restarts while the ship
still has lives. They appear only on the joined socket, not in the common
public world. A live reconnect while the ship still has lives keeps the current
pose. After the socket is gone, Enter Game returns you to that ship for 30
seconds; a longer gap starts a new flight with that score. Game over zeros the
score and starts a new flight. At UTC month rollover, scores and the shared
world both reset.

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
