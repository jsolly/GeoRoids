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
    alt: 'A spinning asteroid passes through a Hauler on a cream tether, then strikes a second ship after the tether timer ends.',
    caption:
      'Controlled demonstration: press E to pull a spinning rock through the Hauler safely. The timed tether releases it toward a second ship, where the normal asteroid collision rule shows a visible impact.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/harpoonField.ts',
      'src/entities/ship/shipRenderer.ts',
      'shared/combat.ts',
    ],
  },
  warden: {
    title: 'Warden shield projection',
    alt: 'A Warden projects a cyan shield to a nearby ally, which reflects an incoming laser back into its shooter.',
    caption:
      'Controlled demonstration: E automatically shields the nearest living ally in reach. The ally reflects a hostile laser into its shooter while the link and three-second timer remain visible.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipShield.ts',
      'src/entities/ship/shieldProjectionRenderer.ts',
      'shared/shieldReflection.ts',
      'src/entities/ship/hullOutlines.ts',
    ],
  },
  skirmisher: {
    title: 'Skirmisher burst fire',
    alt: 'A Skirmisher fires three amber laser bolts in a narrow spread and hits a second ship.',
    caption:
      'Controlled demonstration: press E to fire three shots in a tight spread; one bolt reaches the target hull.',
    sources: [
      'src/entities/ship/Ship.ts',
      'src/entities/ship/shipKits.ts',
      'src/entities/satellite/satelliteMath.ts',
      'shared/combat.ts',
    ],
  },
  quake: {
    title: 'Quake shock pulse',
    alt: 'A Quake emits a blue expanding pulse that reaches and pushes a second ship while asteroids scatter.',
    caption:
      'Controlled demonstration: press E to spend fuel and push a nearby ship and rocks outward. The pulse reaches its target without dealing direct damage.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/quakePulseRenderer.ts',
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
    title: 'Reflective shield lanes',
    alt: 'A Warden projected shield and a regular F shield show separate cyan rings while incoming lasers turn back.',
    caption:
      'Controlled demonstration: Warden E projects a three-second reflective shield to an ally; the separate Warden F shield reflects lasers for four seconds. Their timers run independently.',
    sources: [
      'src/entities/ship/shipAbilities.ts',
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
      'src/physics/shockwave.ts',
      'src/constants/index.ts',
      'src/entities/roid/materialArt.ts',
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
    alt: 'An Echo pickup auto-collects, orbits its pilot, and shows a reduced health bar after intercepting a hostile laser.',
    caption:
      'Controlled demonstration: a nearby Echo attaches automatically, keeps orbiting while a hostile laser removes 25 health, and remains active after the hit.',
    sources: [
      'server/core/SatellitePickupManager.ts',
      'src/entities/satellitePickup/satellitePickupMath.ts',
      'src/entities/satellitePickup/satellitePickupRenderer.ts',
    ],
  },
};
