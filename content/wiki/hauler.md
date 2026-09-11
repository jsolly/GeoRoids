---
title: Hauler
category: Ships
summary: A heavy hull that reels nearby asteroids in and slings them at enemies with its combat harpoon E ability.
order: 40
related:
  - content/wiki/controls.md
  - content/wiki/fuel-growth.md
  - content/wiki/factions.md
media:
  - heading: Harpoon E
    demo: hauler
---

## Harpoon E

E attaches to the nearest valid asteroid in reach, or a hostile ship when no
rock is in reach. Reach is view-aware and expands with the visible area.
Same-faction, shielded, exploding, and dead targets are ignored.

A latched asteroid on an unchanged collision course with a hostile ship keeps
its heading. Other latched asteroids reel toward the Hauler, then release near
the hull toward the enemy's predicted position. Targeting ignores allies,
dead, exploding, respawning, spawn-protected, and shielded ships and considers
reachable intercepts.

A stationary rock chooses the quickest reachable intercept after reeling. If no
eligible enemy remains at release, the rock bounces away from the Hauler. The
tether can extend for distant rocks so the gradual reel can reach the hull; a
directly latched hostile ship is still pulled toward the Hauler. While an
asteroid is latched, it cannot damage its Hauler; normal asteroid collisions
resume after the tether expires. A miss does not spend the cooldown.
