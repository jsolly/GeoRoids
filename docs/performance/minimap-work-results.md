# Player-only minimap work comparison

The player-only minimap does less measured work on every frame of the fixed
portrait fixture. Two independent observations per arm matched exactly across
all 120 measured frames. Both arms used seed 42 and 30 warmup frames. The only
changes between arms restored or removed the original satellite and pickup
minimap rendering. The contour index and all other current changes stayed fixed.

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

That removes six Canvas strokes and twelve satellite/pickup position reads per
frame in this fixture. Other measured work, including asteroid reads, contour
reads and update calls, stayed equal. The original minimap already omitted
asteroids; its removed rendering traversed satellites and pickups.

Gameplay outcomes matched. Final pixels intentionally differ because the unwanted
markers are gone. This is a permanent product choice, not a temporary graphics
reduction. Work counts do not prove a frame-time or FPS improvement. Canvas method
counts describe API calls, not GPU draw calls, and are not weighted CPU costs.

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
