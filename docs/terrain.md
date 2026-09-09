# Central mountain

The arena is one mountain. The only peak is at the world center; elevation falls smoothly to zero at the circular boundary. Equally spaced elevation contours form concentric rings, packed closest on the steep middle slopes. Elevations are relative values from 0 to 1, without real-world units.

Ships accelerate away from the summit and lose speed while climbing toward it. Thrust can overcome the slope even at maximum mass. The existing hull and mass speed limits still apply; downhill travel does not grant an unlimited speed bonus. The exact summit and arena rim have zero slope. Bots use the same slope force as players.

Laser motion is unchanged. Downhill/uphill laser speed is explicitly deferred in [Todoist](https://app.todoist.com/app/task/6hRqv3q4jP2qxVC2) until John resumes it. The existing short contour highlights under shots remain decorative.

`src/physics/terrain/heightfield.ts` defines the radial cosine mountain and its analytic gradient. `terrainConfig.ts` controls peak height, contour density, downhill acceleration and uphill drag. `slopeForce.ts` applies the shared force. The room seed is retained in network snapshots for compatibility but does not change the mountain shape.

Run the terrain scenarios from the repository root with `npx vitest run tests/unit/systems/isoContourTerrain.test.ts tests/unit/systems/contourLaser.test.ts`. They verify the central peak, radial descent, boundary stability, uphill/downhill travel for light and heavy ships, and agreement with server bot movement.

Deploy both the Vercel client and Railway server when shipping this change. Both processes import the terrain model, so a client-only release leaves them using different physics.
