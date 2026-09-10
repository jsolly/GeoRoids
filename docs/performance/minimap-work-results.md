# Historical player-only minimap work comparison

This is a historical comparison of the player-only minimap candidate. It does
not describe the current product policy. Two independent observations per arm
matched exactly across all 120 measured frames. Both arms used seed 42 and 30
warmup frames. The only changes between arms restored or removed the then-current
satellite and pickup minimap rendering. The contour index and all other changes
in that comparison stayed fixed.

| Operation per frame | Original minimap | Player-only minimap | Difference |
| --- | ---: | ---: | ---: |
| `render.canvas.arc` | 8 | 5 | -3 |
| `render.canvas.beginPath` | 113 | 107 | -6 |
| `render.canvas.lineTo` | 895 | 889 | -6 |
| `render.canvas.moveTo` | 399 | 393 | -6 |
| `render.canvas.restore` | 64 | 58 | -6 |
| `render.canvas.save` | 64 | 58 | -6 |
| `render.canvas.stroke` | 113 | 107 | -6 |
| `render.pickup.positionReads` | 9 | 3 | -6 |
| `render.satellite.positionReads` | 9 | 3 | -6 |

The player-only candidate removed six Canvas strokes and twelve satellite/pickup
position reads per frame in this fixture. Other measured work, including asteroid
reads, contour reads and update calls, stayed equal. The compared original
minimap already omitted asteroids and loot; its removed rendering traversed
satellites and pickups.

Gameplay outcomes matched. Final pixels intentionally differ because those
markers were removed in the candidate. This result is retained as historical
evidence and does not establish a current graphics policy. Work counts do not
prove a frame-time or FPS improvement. Canvas method counts describe API calls,
not GPU draw calls, and are not weighted CPU costs.

## Current product policy

The current minimap restores compact marks for live asteroids, loot drops,
hostile satellites, loose satellite pickups, and orbiting pickups. It reads each
entity’s current position on every draw, skips dead or exploding entities, and
lets authoritative removal clear collected or expired objects. World marks are
batched by category and pilots are drawn on top. A new matched timing comparison
would be required before making a current frame-rate claim from this policy.

A September 10, 2026 observation of the restored marks used the same seed 42,
30 warmup frames, and 120 measured touch-portrait frames. The fixture contains
24 asteroids, six wreckage drops, three satellites, and three loose pickups.
Every measured frame used 110 Canvas strokes, compared with the historical
player-only reference of 107. Satellite and pickup position reads were six each,
compared with three each; contour endpoint reads stayed at 1,388. This is a
single deterministic work observation, not a matched timing or phone FPS result.
Other loot kinds and attached orbiters are covered by rendering tests.

The report is `.performance/projectiles-minimap/frame-work.json`, SHA-256
`38c1c1946b2f5925c87ab5f4e03253edd2c579d2e2b18c728adc39d6151f46b7`.

## Artifact receipt

Raw reports live under `.performance/mobile/`. The result is
`minimap-work-comparison.json`. Source, benchmark and dependency identities
are retained in each report and checked across the two arms.

| Raw report | SHA-256 |
| --- | --- |
| `minimap-work-baseline-1.json` | `28338bf8b2378b8428f505ba1385076568e99d0923d253c7fc85fb2340ba54df` |
| `minimap-work-baseline-2.json` | `501c401fbc4099fef397bace2fe7203722b0c0f6902d6b1018d38581c2127a5b` |
| `minimap-work-candidate-1.json` | `5a5d1e258e6705099eb912131b4f21b8424b0b8d0af067587e99549ae3b121c6` |
| `minimap-work-candidate-2.json` | `34a1979dd37309c8dd57298da496bb8336595aa2717ddb78d5771ca666dac275` |
