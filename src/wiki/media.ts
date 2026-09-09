export interface WikiMediaEntry {
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
  dart: {
    title: 'Dart boost dash',
    alt: 'A Dart hull gains a short forward burst and leaves a bright motion trail.',
    caption:
      'Controlled demonstration: press E for a forward boost, then coast as friction slows the ship.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  hauler: {
    title: 'Hauler harpoon',
    alt: 'A Hauler latches a cream tether to a nearby asteroid and pulls it inward.',
    caption:
      'Controlled demonstration: press E to hook a nearby rock. The cable pulls it toward the Hauler, then releases when its timer ends.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/harpoonField.ts',
      'src/entities/ship/shipRenderer.ts',
    ],
  },
  warden: {
    title: 'Warden shield focus',
    alt: 'A Warden hull raises a cyan shield ring while an incoming laser is absorbed.',
    caption:
      'Controlled demonstration: an incoming shot disappears against the active E shield. The shield ring disappears when its timer expires.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipShield.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  skirmisher: {
    title: 'Skirmisher burst fire',
    alt: 'A Skirmisher fires three amber laser bolts in a narrow spread.',
    caption: 'Controlled demonstration: press E to fire three shots in a narrow spread.',
    sources: [
      'src/entities/ship/Ship.ts',
      'src/entities/ship/shipKits.ts',
      'src/entities/satellite/satelliteMath.ts',
    ],
  },
  quake: {
    title: 'Quake shock pulse',
    alt: 'A Quake emits a cyan expanding pulse that pushes nearby asteroids away.',
    caption:
      'Controlled demonstration: press E to spend fuel and push nearby rocks outward. They keep moving after the pulse ends.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/constants/index.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  movement: {
    title: 'Thrust and drift',
    alt: 'A Dart accelerates while thrusting, then coasts as friction slows it.',
    caption: 'Controlled demonstration: hold thrust to accelerate, then release it to coast.',
    sources: [
      'src/entities/ship/shipUtils.ts',
      'src/constants/index.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  terrain: {
    title: 'Terrain slope force',
    alt: 'A Dart coasts across the contour map while an arrow shows the downhill pull.',
    caption:
      'Controlled demonstration: contour lines show the landscape while an arrow marks the downhill pull on a coasting ship.',
    sources: [
      'src/physics/terrain/heightfield.ts',
      'src/physics/terrain/contours.ts',
      'src/physics/terrain/slopeForce.ts',
      'src/rendering/contourLabels.ts',
    ],
  },
  loot: {
    title: 'Loot blast and growth',
    alt: 'A laser destroys one loot drop and blasts a small asteroid outward. A Dart collects a separate shard and grows.',
    caption:
      'Controlled demonstration: shoot one drop to detonate it and push a small rock. Collect a separate shard to grow.',
    sources: ['shared/lootBlast.ts', 'shared/shipGrowth.ts', 'src/entities/loot/lootRenderer.ts'],
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
    title: 'Shield timers',
    alt: 'A Warden timed shield and the regular F shield are shown as separate cyan rings.',
    caption:
      'Controlled demonstration: Warden E lasts three seconds; the separate F laser shield lasts two. Their timers run independently.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipShield.ts',
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
      'src/physics/shockwave.ts',
      'src/constants/index.ts',
      'src/entities/roid/materialArt.ts',
    ],
  },
  slingshot: {
    title: 'Hauler slingshot',
    alt: 'A Hauler swings around a latched asteroid, then releases with tangential momentum.',
    caption:
      'Controlled demonstration: latch onto a rock, orbit it, then release along the tangent and coast.',
    sources: [
      'shared/asteroidMotion.ts',
      'docs/asteroid-interactions.md',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  winch: {
    title: 'Winch coupling',
    alt: 'A Hauler tether links a primary asteroid to a second payload as their angular momentum couples.',
    caption:
      'Controlled demonstration: attach a second rock to share momentum, then release the pair.',
    sources: [
      'shared/asteroidMotion.ts',
      'server/core/AsteroidMotionService.ts',
      'src/entities/ship/shipRenderer.ts',
    ],
  },
  satellites: {
    title: 'EO satellite patrol',
    alt: 'Six separate satellite views show patrol motion and projectiles from each firing pattern.',
    caption:
      'Controlled demonstration: six separate views compare real satellite patrols and firing patterns. The first volleys start together for comparison.',
    sources: [
      'shared/eoSatellites.ts',
      'server/core/SatelliteManager.ts',
      'scripts/wiki-satellite-demo.ts',
      'src/entities/satellite/satelliteMath.ts',
      'src/entities/satellite/eoOutlines.ts',
    ],
  },
  pickups: {
    title: 'Satellite pickup orbit',
    alt: 'A collected satellite pickup changes to an orbiting state and circles the pilot.',
    caption:
      'Controlled demonstration: an Echo pickup orbits its collector for three seconds, then returns to the field.',
    sources: [
      'server/core/SatellitePickupManager.ts',
      'src/entities/satellitePickup/satellitePickupMath.ts',
      'src/entities/satellitePickup/satellitePickupRenderer.ts',
    ],
  },
};
