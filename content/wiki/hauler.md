---
title: Hauler
category: Ships
summary: A heavy hull that tows asteroids to arena furnaces and mines metal efficiently.
order: 40
related:
  - content/wiki/controls.md
  - content/wiki/asteroids.md
  - content/wiki/combat-survival.md
  - content/wiki/loot-growth.md
  - content/wiki/teamwork.md
media:
  - heading: Tow cable E
    demo: hauler
---

## Tow cable E

E attaches a tow cable to the nearest living asteroid within a fixed 280-unit
hull gap. The ability never targets a ship, and it cannot deal ship damage.

The asteroid keeps its existing motion and trails behind the Hauler as the
Hauler flies under normal thrust and steering. Surveyor and Hauler share the
same cruise speed; Hauler Boost is weaker than Surveyor Boost. The cable only
applies a small correction when it is stretched; it never reels a rock into the
hull or throws it toward a target. A successful attachment starts the
three-second ability cooldown, while pressing E again releases the cable without
waiting for cooldown.
The cable and ability display update when the server confirms the action. If no eligible
rock is in range, the attempt leaves the cable detached and does not start a
cooldown. While towing, the touch button reads Release and stays available.
After release, a new attachment waits for any remaining cooldown. A dead or
removed rock detaches automatically. If the towed asteroid overlaps another
asteroid, both rocks use the ordinary collision break and the cable detaches.
If it overlaps another ship, that ship takes a normal asteroid impact, the cargo
breaks, and the cable detaches. The Hauler stays unharmed by its own cargo,
including when that cargo is the rock that hits another deposit. Spawn protection
still prevents the ship impact. Untowed rocks pass through each other.

Fly the towed asteroid into an arena furnace to deliver it. Delivery consumes
the rock and awards the Hauler. If a Surveyor scanned the rock, the Hauler and
each Surveyor contributor receive identical delivery points.

Hauler passive exploration reaches 260 world units and contributes to the same
persistent crew chart as Surveyor. Use the shared chart to follow discovered
furnace markers; the local radar shows a discovered furnace while it is within
the nearby radar view, and the universe map keeps its exact landmark anywhere
in the explored world.

## Mining lasers

Hauler deals double mining damage to metal asteroids and cooperative large rocks.
Metal takes two hits instead of three. Small ice and rubble already break in
one hit. The different-pilot requirement for cooperative large-rock splits
remains unchanged. Lasers mine asteroids only; they cannot damage teammates.
