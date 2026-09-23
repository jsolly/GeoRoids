# Varied isoline terrain

The arena retains broad nearly level plains between seeded hills and valleys. Elevation combines smooth multi-scale noise with Gaussian landmarks. A flat spawn at the center keeps arriving pilots stable. Contours retain the original density while shallow winding cuts reshape narrow passages. Their labels use compressed relative elevations. Plains retain 1% of the original height variation; their contours remain visible but have trivial differences. Intervals are nonuniform, so contour spacing alone no longer measures steepness. Gameplay displays the original full contour density with one-pixel strokes and faint slate opacity. A 75-degree cone centered on steering heading colors local straight-line routes from the ship toward each segment: amber uphill, blue downhill, neutral flat/cross-slope. The cone fades over its outer five degrees; contours outside remain slate. Each segment projects its local gradient onto the direction from the ship, so colors can reverse beyond a crest; the preview does not simulate cross-slope drift. Contours have no travel text, arrow, or echo animation. Elevation labels retain their original spacing.

The generator smoothly compresses a low-relief band while retaining tiny variations. Existing world seed, saved progress and world generation remain unchanged.

`src/physics/terrain/passages.ts` defines two seeded warped families of narrow,
interconnected passages with constant-time sampling. Their smooth proximity
profile compresses local elevation before both contour extraction and physical
height mapping, preserving the landscape outside the cuts. Alignment in either
direction blends normal terrain travel toward 1.5× cruise using the fourth power
of the tangent dot product. The advantage fades across each edge and when
turning across the route. Intersections take the larger alignment rather than
summing bonuses. A bright violet tint and faint glow on passage contours remains visible in every direction;
meaningful amber/blue slope previews take priority in the forward cone. Passage
strength is cached with each contour gradient. No route membership, wind, or
auto-steering is stored. The
starter area and world edge smoothly disable passages. Local speed validation
uses the same geometry; the existing global downhill ceiling still covers all
passage travel, including Boost.

Ships accelerate downhill and lose speed uphill. Bots, released pilots, and local ships share the same slope force and existing speed limits.

Laser motion is unchanged. Downhill/uphill laser speed is explicitly deferred in [Todoist](https://app.todoist.com/app/task/6hRqv3q4jP2qxVC2) until John resumes it. The existing short contour highlights under shots remain decorative.

`src/physics/terrain/heightfield.ts` defines the seeded heightfield and sampled gradient. `terrainConfig.ts` controls terrain feature size, contour density, and slope forces. The room seed in snapshots keeps clients and the server on the same terrain. Gameplay labels are cached in world space so camera movement does not move them along the contours. The homepage uses a fixed terrain preview with denser, muted lines and no stars.

From `/Users/johnsolly/code/GeoRoids`, run `npx vitest run tests/unit/systems/isoContourTerrain.test.ts tests/unit/systems/contourLaser.test.ts tests/unit/ui/titleTerrain.test.ts` for terrain, slope, and homepage coverage. Run `./scripts/test-runner.sh tests/integration/browser/sanity/pilots-climb-and-descend-varied-terrain.test.ts` for desktop/mobile uphill and downhill travel and authoritative server observations.

Deploy both the Vercel client and Railway server. Both import this terrain model, so a client-only release leaves them using different physics.
