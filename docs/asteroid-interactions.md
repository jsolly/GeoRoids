# Reflective asteroids and Hauler slingshots

All actions work during flight, with no menu. **T** cycles asteroids nearest-first, **Q** latches the selected rock or releases a latched Hauler, **R** anchors, **X** brakes, and **C** resumes spin. With no selection, Q/R select the nearest rock. **Escape** clears the selection. The passive readout shows the selected rock, shot prediction and remaining laser-core charges.

On touch, hold one finger on the playfield to steer and thrust toward it. Use a second finger to **tap a rock** to select it and latch, or anchor it as a second rock while latched. Mouse users do the same with the **middle button**; left-click still fires and right-click still thrusts. Drag at least 40 pixels and release to flick: **down releases, left brakes, right spins, up anchors** the rock where the gesture started. Flicks can start on empty playfield when an action needs no new target. Steering and action-button touches remain independent of asteroid gestures, so you can steer while using a tether. Releasing the steering finger stops thrust without triggering a rock action.

**E** and **F** activate the kit ability and shield; their touch buttons do the same. Laser cores equip automatically on pickup and enhance the next six shots. There is no weapon-selection menu.

## Reflective clusters and laser cores

Flat, faceted metal clusters reflect shots from their actual faces. Each bounce increases the shot's energy and charges the rock it hits. A rock breaks when its stored energy fills, or when a shot reaches its energy or bounce limit. The preview includes those limits and the current laser upgrade, so a charged rock can end the preview instead of reflecting it.

Reflected shots can hurt their shooter and faction mates. Ordinary direct shots still respect friendly fire. A broken reflector leaves one laser core: collect it for 150 points and six stronger shots, usable for 60 seconds. The upgrade expires on death. Shots, damage, charge use and collection belong to the shared world, so reconnecting does not replay rewards.

## Hauler spin and winch controls

As a Hauler, select a physical rock and **Latch** to its surface. Fast spinners carry the ship around the rock. Aim tangentially and thrust to add spin, spending fuel; release to retain a bounded tangential boost. The server keeps control through the boost's decay and then returns the ship to ordinary movement.

While latched, select a second nearby rock and use **Anchor** or **Brake** to couple its momentum through the winch. The second asteroid is the payload. Release leaves it moving with its resulting velocity. Other pilots cannot take over an occupied tether, and these controls cannot attach to faction mates.

The cream cable and amber endpoints show the physical connection. A socket interruption shorter than two seconds preserves the attachment with neutral input; a longer interruption, explicit exit, death or missing rock detaches it. Rejoining cannot duplicate the boost or spend fuel while disconnected.

## Multiplayer protocol

Every pilot uses snapshot v1 with `asteroidInteractions:1`, acknowledged by the
server with a private resume token. Unsupported clients cannot join. The server
owns projectile collisions, and clients render keyed projectile snapshots.
Reflective phenomena seed when a pilot enters an active world and remain until
that world ends. Resume tokens are private to the joined socket and never appear
in the common public world.

## Updating open clients

Published client releases automatically refresh open tabs after two matching release checks, about 30–60 seconds for active tabs. The check uses the client origin's `x-release-id`; the independently deployed Railway server does not trigger reloads. A per-tab guard prevents repeated reloads if the edge still serves a cached bundle. Tabs opened before this watcher was shipped need one manual refresh.

Gameplay WebSocket URLs include `asteroidInteractions=1`. Older clients receive
HTTP 426 before the WebSocket opens and must refresh. The join message must also
contain both current capabilities. `/logs` is unaffected. Client and server are
deployed independently; verify each release ID and current multiplayer behavior.
