# Reflective asteroids and Hauler slingshots

Open **TOOLS** or press **Q** to choose a nearby asteroid, inspect its mineral composition and preview the predicted path of a shot. E and F retain their existing kit ability and shield controls.

## Reflective clusters and laser cores

Flat, faceted metal clusters reflect shots from their actual faces. Each bounce increases the shot's energy and charges the rock it hits. A rock breaks when its stored energy fills, or when a shot reaches its energy or bounce limit. The preview includes those limits and the current laser upgrade, so a charged rock can end the preview instead of reflecting it.

Reflected shots can hurt their shooter and faction mates. Ordinary direct shots still respect friendly fire. A broken reflector leaves one laser core: collect it for 150 points and six stronger shots, usable for 60 seconds. The upgrade expires on death. Shots, damage, charge use and collection belong to the shared world, so reconnecting does not replay rewards.

## Hauler spin and winch controls

As a Hauler, select a physical rock and **Latch** to its surface. Fast spinners carry the ship around the rock. Aim tangentially and thrust to add spin, spending fuel; release to retain a bounded tangential boost. The server keeps control through the boost's decay and then returns the ship to ordinary movement.

While latched, select a second nearby rock and use **Anchor** or **Brake** to couple its momentum through the winch. The second asteroid is the payload. Release leaves it moving with its resulting velocity. Other pilots cannot take over an occupied tether, and these controls cannot attach to faction mates.

The cream cable and amber endpoints show the physical connection. A socket interruption shorter than two seconds preserves the attachment with neutral input; a longer interruption, explicit exit, death or missing rock detaches it. Rejoining cannot duplicate the boost or spend fuel while disconnected.

## Compatible rollout

The supporting release accepts `asteroidInteractions:1` only together with snapshot v1 and acknowledges it with a private resume token. Build the client with `VITE_ASTEROID_INTERACTIONS=1` to offer these tools after the matching Railway server is live. The initial supporting client leaves the offer disabled. Unsupported servers keep the ordinary client path.

Existing clients can continue ordinary play. New phenomena first seed when an enhanced pilot enters an active world; they remain until that world ends. The authoritative server then owns every projectile collision. Enhanced clients render keyed projectile snapshots; older clients use the existing shot and reflection events. Resume tokens are private to the joined socket and never placed in the common public world.

## Updating open clients

Published client releases automatically refresh open tabs after two matching release checks, about 30–60 seconds for active tabs. The check uses the client origin's `x-release-id`; the independently deployed Railway server does not trigger reloads. A per-tab guard prevents repeated reloads if the edge still serves a cached bundle. Tabs opened before this watcher was shipped need one manual refresh.

For a release cutover, deploy server support first with `REQUIRE_ASTEROID_CLIENT` unset. After the enhanced Vercel client is READY, set Railway `REQUIRE_ASTEROID_CLIENT=1`. The updated client supplies `asteroidInteractions=1` on its WebSocket URL. Stale clients receive HTTP426 before the WebSocket opens and must refresh; their reconnect attempts cannot repeatedly reset on successful upgrades. `/logs` is unaffected. During the support transition, older clients see laser cores using their existing mineral-pickup visual with the same authoritative pickup identity and reward.
