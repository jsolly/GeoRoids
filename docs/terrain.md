# Varied isoline terrain

The arena contains seeded hills, valleys, and saddles. Elevation combines smooth multi-scale noise with Gaussian landmarks. A flat spawn at the center keeps arriving pilots stable. Equal elevation intervals produce closely spaced contours on steep slopes and widely spaced contours on gentle ground. Faint numbers show relative, unitless elevations, including negative valleys.

Ships accelerate downhill and lose speed uphill. Bots, released pilots, and local ships share the same slope force and existing speed limits.

Laser motion is unchanged. Downhill/uphill laser speed is explicitly deferred in [Todoist](https://app.todoist.com/app/task/6hRqv3q4jP2qxVC2) until John resumes it. The existing short contour highlights under shots remain decorative.

`src/physics/terrain/heightfield.ts` defines the seeded heightfield and sampled gradient. `terrainConfig.ts` controls terrain feature size, contour density, and slope forces. The room seed in snapshots keeps clients and the server on the same terrain. Gameplay labels are cached in world space so camera movement does not move them along the contours. The homepage uses a fixed terrain preview with denser, muted lines and no stars.

From `/Users/johnsolly/code/GeoRoids`, run `npx vitest run tests/unit/systems/isoContourTerrain.test.ts tests/unit/systems/contourLaser.test.ts tests/unit/ui/titleTerrain.test.ts` for terrain, slope, and homepage coverage. Run `./scripts/test-runner.sh tests/integration/browser/sanity/pilots-climb-and-descend-varied-terrain.test.ts` for desktop/mobile uphill and downhill travel and authoritative server observations.

Deploy both the Vercel client and Railway server. Both import this terrain model, so a client-only release leaves them using different physics.
