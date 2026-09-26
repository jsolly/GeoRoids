# Contour travel

The arena contains a seeded heightfield of hills, valleys, and saddles. Smooth multi-scale noise and Gaussian landmarks create the contour geometry used by ships and spider feet. The displayed contours and travel gradient use the same heightfield; there is no separate physical elevation remapping. Height is an internal geometry value: gameplay renders neutral gray contours without elevation labels or an elevation color gradient. Spider influence can still turn nearby segments red.

Ships gain speed when their heading follows the local contour tangent, in either direction. The bonus scales with gradient strength and squared tangent alignment. Crossing perpendicular to the lines keeps normal cruise; the flat starter area has no bonus. There is no climb penalty, downhill drift, or terrain force on stationary ships. Local pilots and their server movement validation share the same contour field and speed ceiling. Kit, mass, and Boost set the baseline; Boost stacks with the contour bonus.

A longer curved contour route can compete with a shorter direct crossing. Laser motion is unchanged, and short contour highlights under shots remain decorative.

`src/physics/terrain/passages.ts` preserves the two seeded warped families of interconnected cuts as geometry only. Their smooth proximity profile reshapes the heightfield used by both contour extraction and travel; the starter area and world edge smoothly disable these cuts. There is no separate passage speed multiplier or route membership. Existing seeds and saved progress remain unchanged.

`src/physics/terrain/heightfield.ts` defines the seeded heightfield and sampled gradient. `terrainConfig.ts` controls feature size, contour density, and travel strength. `terrainTravel.ts` calculates the shared travel velocity. The room seed in snapshots keeps clients and the server on the same terrain. The homepage uses a fixed terrain preview with denser, muted lines and no stars.

From `/Users/johnsolly/code/GeoRoids`, run `npx vitest run tests/unit/systems/isoContourTerrain.test.ts tests/unit/systems/contourLaser.test.ts tests/unit/ui/titleTerrain.test.ts` for terrain, contour, and homepage coverage. Run `./scripts/test-runner.sh tests/integration/browser/sanity/pilots-follow-contours-for-speed.test.ts` for desktop/mobile contour travel and authoritative server observations.

Deploy both the Vercel client and Railway server. Both import this terrain model, so a client-only release leaves them using different physics.
