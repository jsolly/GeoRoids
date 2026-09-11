---
title: Terrain and the boundary
category: Arena
summary: Contour lines reveal slopes that change your motion. The outer wall
  damages ships that cross it.
order: 120
related:
  - content/wiki/controls.md
  - content/wiki/asteroids.md
  - content/wiki/combat-survival.md
  - content/wiki/hud-network.md
media:
  - heading: Slope and contours
    demo: terrain
---

## Read the landscape

The arena contains hills, valleys, and saddles, with a flat spawn area at the
center. Pilots in the same room share the same terrain. Slopes accelerate your
ship downhill and resist travel uphill. Terrain itself does not deal damage.

The circular arena is 6,000 units across with a 100 unit buffer; the damaging
boundary comes from that geometry. The asteroid belt uses a separate radius.
Crossing the boundary deals damage per impact; a healthy heavy hull can survive
the first hit, but staying outside remains dangerous.

## Slope and contours

Contour lines are closest together on steep slopes and farther apart on gentle
ground. Faint numbers mark relative elevations, including negative values in
valleys. Watch the contours and your drift to tell uphill from downhill.
Normal hull and mass speed limits still apply, and bots feel the same slope
force. Lasers keep their normal motion; glints where shots cross contours are
visual feedback, with no terrain reflection or extra damage.
