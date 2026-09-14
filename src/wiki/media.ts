interface WikiMediaEntry {
  title: string;
  alt: string;
  caption: string;
  sources: string[];
}

/**
 * Generated wiki demonstrations. Keep the source list beside the copy so a
 * gameplay change has an obvious media review surface.
 */
export const media: Record<string, WikiMediaEntry> = {
  surveyor: {
    title: 'Surveyor mineral scan',
    alt: 'A Surveyor scan changes nearby radar dots into distinct ice, metal, and rubble marks, then returns them to ordinary dots.',
    caption:
      'Press E to identify nearby asteroid minerals temporarily. Circles mark ice, squares metal, and triangles rubble.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/surveyScan.ts',
      'src/rendering/hud/minimap.ts',
      'src/entities/ship/shipKits.ts',
    ],
  },
  hauler: {
    title: 'Hauler harpoon',
    alt: 'A spinning asteroid reels toward a Hauler on a cream tether, then reverses near its hull and strikes an enemy ship.',
    caption:
      'Controlled demonstration: E reels the spinning rock toward the Hauler, then bounces it back toward the enemy. The released rock coasts freely until impact.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/harpoonField.ts',
      'src/entities/ship/harpoonSling.ts',
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipRenderer.ts',
      'shared/combat.ts',
    ],
  },
  movement: {
    title: 'Automatic thrust and steering',
    alt: 'A Surveyor accelerates automatically, turns its nose, and keeps flying after steering is released.',
    caption:
      'Controlled demonstration: thrust stays on while steering turns the ship; releasing steering keeps it flying.',
    sources: [
      'src/entities/ship/shipUtils.ts',
      'src/constants/index.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  terrain: {
    title: 'Terrain slope force',
    alt: 'A Surveyor thrusts across the contour map while an arrow shows the downhill pull.',
    caption:
      'Controlled demonstration: contour lines show the landscape while an arrow marks the downhill pull on a ship with automatic thrust.',
    sources: [
      'src/physics/terrain/heightfield.ts',
      'src/physics/terrain/contours.ts',
      'src/physics/terrain/terrainConfig.ts',
      'src/physics/terrain/slopeForce.ts',
      'src/rendering/contourLabels.ts',
    ],
  },
  loot: {
    title: 'Loot blast and growth',
    alt: 'A laser destroys one loot drop and blasts a small asteroid outward. A remaining shard flies toward a Surveyor and is collected, growing the ship.',
    caption:
      'Controlled demonstration: shoot one drop to detonate it and push a small rock. A remaining shard magnetizes to the hull and grows the ship.',
    sources: [
      'shared/lootBlast.ts',
      'shared/shipGrowth.ts',
      'server/core/LootManager.ts',
      'src/entities/loot/lootRenderer.ts',
    ],
  },
  reflection: {
    title: 'Reflective asteroid',
    alt: 'An amber laser strikes a faceted metal asteroid and reflects from its polygon face.',
    caption:
      'Controlled demonstration: a laser bounces from a metal face along the predicted path. A ricochet can hit its shooter or an ally.',
    sources: [
      'shared/asteroidReflection.ts',
      'shared/asteroidPhenomena.ts',
      'src/entities/roid/materialArt.ts',
    ],
  },
  shield: {
    title: 'Reflective shield',
    alt: 'A Surveyor raises its F shield and reflects an incoming laser.',
    caption:
      'The timed F shield reflects incoming lasers. Its cooldown starts when the shield ends.',
    sources: [
      'src/entities/ship/shipShield.ts',
      'shared/shieldReflection.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  split: {
    title: 'Cooperative asteroid split',
    alt: 'Two laser hits from different pilots break a large asteroid into two smaller fragments.',
    caption:
      'Controlled demonstration: two pilots hit one large rock within the collaboration window. It splits and sends out two shockwaves.',
    sources: [
      'server/core/AsteroidManager.ts',
      'shared/asteroidPhenomena.ts',
      'src/physics/shockwave.ts',
      'src/constants/index.ts',
      'src/entities/roid/materialArt.ts',
    ],
  },
  satellites: {
    title: 'EO satellite pickups',
    alt: 'Six separate satellite views show the Earth-observation hulls drifting as collectible pickups.',
    caption:
      'Controlled demonstration: six separate views compare the live Earth-observation pickup hulls. They drift as collectible hardware rather than firing.',
    sources: [
      'shared/eoSatellites.ts',
      'server/core/SatellitePickupManager.ts',
      'scripts/wiki-satellite-demo.ts',
      'src/entities/satellite/eoOutlines.ts',
    ],
  },
  pickups: {
    title: 'Satellite pickup orbit',
    alt: 'A Landsat 7 pickup auto-collects, orbits its pilot, and shows a reduced health bar after intercepting a hostile laser.',
    caption:
      'Controlled demonstration: a nearby Landsat 7 attaches automatically, keeps orbiting while a hostile laser removes 25 health, and remains active after the hit.',
    sources: [
      'server/core/SatellitePickupManager.ts',
      'src/constants/index.ts',
      'src/entities/satellitePickup/satellitePickupMath.ts',
      'src/entities/satellitePickup/satellitePickupRenderer.ts',
      'src/entities/satellite/eoOutlines.ts',
    ],
  },
};
