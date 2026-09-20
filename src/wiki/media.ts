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
    title: 'Surveyor shared mineral scan',
    alt: 'A Surveyor activates a range-limited scan while a teammate radar receives ice, metal, and rubble marks for the same rocks.',
    caption:
      'Press E to classify nearby rocks on every teammate radar. The scan also records the Surveyor as a contributor for a later furnace delivery.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/surveyScan.ts',
      'src/entities/ship/shipRenderer.ts',
      'src/rendering/hud/minimap.ts',
      'src/rendering/hud/resourceMapMark.ts',
      'src/entities/ship/shipKits.ts',
      'server/core/GameEngine.ts',
      'shared/exploration.ts',
    ],
  },
  hauler: {
    title: 'Hauler tow cable and furnace delivery',
    alt: 'A Hauler tows a spinning asteroid behind its hull toward a furnace while a Surveyor watches the shared delivery score.',
    caption:
      'Controlled demonstration: E attaches a moving asteroid, the rock trails behind normal Hauler movement, and the crew brings it to a furnace for equal Hauler and Surveyor credit.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/harpoonField.ts',
      'src/entities/ship/towCable.ts',
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipRenderer.ts',
      'src/entities/ship/hullOutlines.ts',
      'shared/furnaces.ts',
      'src/rendering/furnaceRenderer.ts',
      'server/core/GameEngine.ts',
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
    title: 'Terrain contours and slope travel',
    alt: 'A Surveyor rides contour lines, then turns downhill while an arrow shows the descent.',
    caption:
      'Controlled demonstration: automatic thrust follows a contour, then the nose turns downhill so speed more than doubles; an arrow marks the downhill direction.',
    sources: [
      'src/physics/terrain/heightfield.ts',
      'src/physics/terrain/contours.ts',
      'src/physics/terrain/terrainConfig.ts',
      'src/physics/terrain/terrainTravel.ts',
      'src/entities/ship/cruiseMotion.ts',
      'src/rendering/contourLabels.ts',
    ],
  },
  loot: {
    title: 'Loot blast and collect',
    alt: 'A laser destroys one loot drop and blasts a small asteroid outward. A remaining shard flies toward a Surveyor and is collected without changing the hull size.',
    caption:
      'Controlled demonstration: shoot one drop to detonate it and push a small rock. A remaining shard magnetizes to the hull and is collected.',
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
      'Controlled demonstration: a laser bounces from a metal face along the predicted path. After that bounce the shot is a hull hazard while remaining a bounded asteroid interaction.',
    sources: [
      'shared/asteroidReflection.ts',
      'shared/asteroidPhenomena.ts',
      'src/entities/roid/materialArt.ts',
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
    alt: 'Six separate satellite views show the Earth-observation hulls glowing as stationary collectible pickups.',
    caption:
      'Controlled demonstration: six separate views compare the live Earth-observation pickup hulls. They stay stationary and glow until collected and equipped.',
    sources: [
      'shared/eoSatellites.ts',
      'server/core/SatellitePickupManager.ts',
      'scripts/wiki-satellite-demo.ts',
      'src/entities/satellitePickup/satellitePickupGlow.ts',
      'src/entities/satellite/eoOutlines.ts',
    ],
  },
  pickups: {
    title: 'Satellite pickup orbit',
    alt: 'An equipped Landsat 7 orbits its pilot and shows reduced health after a physical hit.',
    caption:
      'Controlled demonstration: Landsat 7 is collected into inventory and explicitly equipped, then remains in orbit after one physical hit. The green health bar drains with time, and the hit shortens its remaining lifetime.',
    sources: [
      'server/core/SatellitePickupManager.ts',
      'src/constants/index.ts',
      'src/entities/satellitePickup/satellitePickupMath.ts',
      'src/entities/satellitePickup/satellitePickupRenderer.ts',
      'src/entities/satellitePickup/satellitePickupGlow.ts',
      'src/entities/satellitePickup/satelliteHealthRenderer.ts',
      'src/entities/satellite/eoOutlines.ts',
    ],
  },
  survival: {
    title: 'Surviving an asteroid impact',
    alt: 'A Surveyor clips an environmental asteroid, loses 25 health, and keeps flying with a visible 75 out of 100 health capsule.',
    caption:
      'Controlled demonstration: one server-sized asteroid impact removes 25 health, leaves the Surveyor alive, and lets it continue flying clear of the hazard.',
    sources: [
      'src/entities/ship/Ship.ts',
      'src/entities/ship/shipUtils.ts',
      'src/constants/index.ts',
      'shared/combat.ts',
      'server/core/CollisionAuthority.ts',
      'tests/integration/server/pilots-see-health-recover-after-an-asteroid-impact.test.ts',
    ],
  },
};
