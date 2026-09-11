import { ASTEROID_INTERACTIONS } from '../../shared/asteroidPhenomena';
import { SATELLITE_PROFILES } from '../../shared/eoSatellites';
import { LOOT_BLAST } from '../../shared/lootBlast';
import { GROWTH } from '../../shared/shipGrowth';
import {
  DAMAGE,
  FUEL,
  GAME,
  ROID,
  SATELLITE,
  SATELLITE_PICKUP,
  SHIELD,
  SHIP,
  SHOCKWAVE,
} from '../constants';
import { SHIP_ABILITY } from '../entities/ship/shipKits';
import { getGameBoundary } from '../physics/boundary';

export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  summary: string;
  sections: WikiSection[];
  related: string[];
  sources: string[];
}

export interface WikiSection {
  heading: string;
  paragraphs: string[];
  media?: string;
}

/** Return demonstrations in the same order as their owning article sections. */
export function mediaForArticle(article: WikiArticle): string[] {
  return article.sections.flatMap((section) =>
    section.media === undefined ? [] : [section.media]
  );
}

function seconds(frames: number): string {
  return `${frames / GAME.FPS} seconds`;
}

function satelliteProfiles(): string[] {
  const patterns = {
    steady: 'a steady, aimed single shot',
    'wide-sweep': 'a three-shot fan that sweeps a wide angle',
    'spin-burst': 'a rotating six-shot burst',
    'weather-beam': 'four fast shots along one narrow line',
    'radar-sweep': 'a two-shot sweep',
    'precision-stab': 'a fast, tightly aimed single shot',
  };
  return SATELLITE_PROFILES.map(
    (profile) =>
      `${profile.displayName} fires ${patterns[profile.shotPattern]}. It starts a volley every ${(profile.cadenceFrames / GAME.FPS).toFixed(2)} seconds; its projectiles travel at ${profile.speedMultiplier} times normal satellite shot speed.`
  );
}

export const articles: WikiArticle[] = [
  {
    id: 'field-manual',
    title: 'Read the field',
    category: 'Start here',
    summary:
      'Learn the five ships, read the hazards, and understand what happens when you fire, collide, collect, and respawn.',
    sections: [
      {
        heading: 'What the manual covers',
        paragraphs: [
          'The field contains a moving asteroid belt, six hostile Earth-observation satellite types, satellite pickups, sloping terrain, and pilots who can be assigned to the ION or EMBER side. Choose a kit, learn its E ability, then read the arena entries for the rules that every pilot shares.',
          'The five starting kits are Dart, Hauler, Warden, Skirmisher, and Quake. Their starting health, handling, shot interval, and ability cooldowns are fixed by the kit data; loot changes a living ship’s mass and health curve during a life, while a respawn resets that growth.',
        ],
      },
      {
        heading: 'Start a life',
        paragraphs: [
          'Choose a ship on the title screen, then press Enter Game. You share the field with other pilots and bots. Destroy hazards and hostile ships, collect rewards, and protect your three lives. Your score carries across respawns, but the mass and upgrades gathered during a life do not. The manual explains current rules; practical tips are brief because new ways to combine these mechanics can emerge.',
        ],
      },
    ],
    related: ['controls', 'dart', 'asteroids', 'hud-network'],
    sources: [
      'src/core/gameController.ts',
      'src/constants/index.ts',
      'server/core/GameEngine.ts',
      'shared-types.ts',
      'tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts',
    ],
  },
  {
    id: 'controls',
    title: 'Controls',
    category: 'Start here',
    summary:
      'Keyboard, mouse, and touch all drive the same thrust, aim, fire, ability, and shield actions.',
    sections: [
      {
        heading: 'Keyboard',
        media: 'movement',
        paragraphs: [
          'Use ArrowUp or W to thrust. ArrowLeft or A and ArrowRight or D turn the ship; opposing turn inputs cancel. Space fires. E activates the selected kit ability and F toggles the regular laser shield. E and F are edge-triggered so holding the key does not repeatedly activate them.',
          `The shared starting movement values are thrust ${SHIP.THRUST}, a maximum velocity of ${SHIP.MAX_VELOCITY}, and a turn rate of ${SHIP.TURN_SPEED} degrees per second. The movement step applies the shared friction value of ${GAME.FRICTION} while the ship is coasting. The kit pages list the handling values that replace these defaults for each hull.`,
        ],
      },
      {
        heading: 'Mouse',
        paragraphs: [
          'On desktop, the ship aims from the canvas center toward the pointer. Hold the left mouse button to fire and the right mouse button to thrust. Keep the pointer in the direction you want the nose to face; thrust follows that heading.',
        ],
      },
      {
        heading: 'Touch',
        paragraphs: [
          'On touch screens, touch and hold the playfield to steer toward your finger and thrust. Drag to change direction; release to stop thrusting and coast. A touch directly on the ship keeps its current heading. Hold FIRE with another finger to fire, and use the ability and SHIELD buttons for the same actions as E and F. Action buttons do not steer the ship.',
        ],
      },
    ],
    related: ['field-manual', 'dart', 'hauler'],
    sources: [
      'src/input/keybindings.ts',
      'src/input/mouse.ts',
      'src/input/touchControls.ts',
      'src/input/touchAbility.ts',
      'src/input/controlSources.ts',
      'src/constants/index.ts',
      'tests/integration/entities/input/keybindings.test.ts',
      'tests/integration/entities/input/mouse.test.ts',
      'tests/unit/input/touchAbility.test.ts',
      'tests/unit/input/mouseDesktop.test.ts',
    ],
  },
  {
    id: 'dart',
    title: 'Dart',
    category: 'Ships',
    summary:
      'A balanced hull with the quickest kit ability: E adds a short forward dash to the ship’s current velocity.',
    sections: [
      {
        heading: 'Boost dash',
        media: 'dart',
        paragraphs: [
          `E adds a forward burst of ${SHIP_ABILITY.DASH_BOOST}; release the input and friction carries the ship into a short coast.`,
        ],
      },
    ],
    related: ['controls', 'combat-survival', 'warden'],
    sources: [
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipAbilities.ts',
      'src/constants/index.ts',
      'tests/unit/entities/shipKits.test.ts',
      'tests/unit/entities/shipAbilities.test.ts',
    ],
  },
  {
    id: 'hauler',
    title: 'Hauler',
    category: 'Ships',
    summary: 'A heavy hull that pulls nearby targets with its combat harpoon E ability.',
    sections: [
      {
        heading: 'Harpoon E',
        media: 'hauler',
        paragraphs: [
          `E attaches to the nearest valid asteroid in reach, or a hostile ship when no rock is in reach. Reach is view-aware, starts at ${SHIP_ABILITY.HARPOON_RANGE} units, and expands with the visible area. Same-faction, shielded, exploding, and dead targets are ignored. A successful harpoon pulls for up to ${seconds(SHIP_ABILITY.HARPOON_FRAMES)}. While an asteroid is attached, it can pass through the Hauler without collision damage; unrelated asteroids and other pilots keep normal collision damage. When the attachment ends, the asteroid collides normally again. A miss does not spend the cooldown.`,
        ],
      },
    ],
    related: ['controls', 'fuel-growth', 'factions'],
    sources: [
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipRenderer.ts',
      'src/entities/ship/harpoonField.ts',
      'tests/unit/entities/shipKits.test.ts',
      'tests/unit/entities/shipAbilities.test.ts',
      'tests/unit/scenarios/combat/hauler-harpoons-a-nearby-ship.test.ts',
      'tests/unit/scenarios/combat/hauler-harpoons-a-nearby-asteroid.test.ts',
    ],
  },
  {
    id: 'warden',
    title: 'Warden',
    category: 'Ships',
    summary: 'A durable hull whose E projects a reflective shield to a nearby ally.',
    sections: [
      {
        heading: 'Shield projection',
        media: 'warden',
        paragraphs: [
          `E automatically projects a ${seconds(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES)} reflective laser shield to the nearest living allied ship within ${SHIP_ABILITY.SHIELD_PROJECTION_RANGE} world units between hull edges, preferring the forward hemisphere and then the nearest fallback. There is no precise aim; a miss does not spend the cooldown. The cyan link stays visible while the projection is active. The projected shield reflects hostile player, bot, and EO lasers back toward their source but does not stop collisions. An exploding loot drop bypasses both shields; spawn protection blocks that blast.`,
        ],
      },
      {
        heading: 'Reflective F shield',
        media: 'shield',
        paragraphs: [
          `F raises the Warden’s own reflective laser shield for ${SHIELD.WARDEN_DURATION_SECONDS} seconds and has a ${SHIELD.COOLDOWN_SECONDS} second cooldown. F reflects hostile lasers but does not stop environmental collisions. E and F are separate timers.`,
        ],
      },
    ],
    related: ['controls', 'combat-survival', 'factions'],
    sources: [
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/shipShield.ts',
      'src/entities/ship/shieldProjectionRenderer.ts',
      'src/entities/ship/Ship.ts',
      'shared/shieldReflection.ts',
      'src/constants/index.ts',
      'tests/unit/entities/shipKits.test.ts',
      'tests/unit/entities/shipAbilities.test.ts',
      'tests/unit/entities/shipShield.test.ts',
      'tests/unit/entities/shipDamage.test.ts',
      'tests/unit/shared/shieldReflection.test.ts',
      'tests/integration/browser/sanity/shields-send-lasers-back-to-the-shooter.test.ts',
    ],
  },
  {
    id: 'skirmisher',
    title: 'Skirmisher',
    category: 'Ships',
    summary: 'A light, fast hull whose E ability fires a three-shot burst in a narrow spread.',
    sections: [
      {
        heading: 'Burst fire',
        media: 'skirmisher',
        paragraphs: [
          'E fires three lasers in a tight burst. The volley can hit the same target, while the shared laser limit still applies.',
        ],
      },
    ],
    related: ['controls', 'combat-survival', 'factions'],
    sources: [
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/Ship.ts',
      'src/constants/index.ts',
      'tests/unit/entities/shipKits.test.ts',
      'tests/unit/entities/shipAbilities.test.ts',
    ],
  },
  {
    id: 'quake',
    title: 'Quake',
    category: 'Ships',
    summary:
      'A medium hull whose E shock pulse spends fuel to push nearby ships and asteroids away.',
    sections: [
      {
        heading: 'Shock pulse',
        media: 'quake',
        paragraphs: [
          `E spends ${FUEL.EMP_COST} fuel to push ships and asteroids within ${SHIP_ABILITY.SHOCK_RADIUS} units. It pushes allies too and deals no direct damage; the tank must have enough fuel to fire. The blue expanding ring marks the activation area, briefly lingering at the point where the pulse began.`,
        ],
      },
    ],
    related: ['controls', 'fuel-growth', 'asteroids', 'combat-survival'],
    sources: [
      'src/entities/ship/shipKits.ts',
      'src/entities/ship/shipAbilities.ts',
      'src/entities/ship/quakePulseRenderer.ts',
      'src/constants/index.ts',
      'shared/fuel.ts',
      'tests/unit/entities/shipKits.test.ts',
      'tests/unit/entities/shipAbilities.test.ts',
      'tests/unit/entities/emp-spends-fuel-when-activated.test.ts',
    ],
  },
  {
    id: 'fuel-growth',
    title: 'Fuel, loot, and growth',
    category: 'Systems',
    summary:
      'Fuel powers Quake’s shock pulse. Collect loot to grow, or shoot a drop to create a dangerous blast.',
    sections: [
      {
        heading: 'Fuel',
        paragraphs: [
          `Every kit starts a life with ${FUEL.START} fuel and has a ${FUEL.MAX} fuel maximum. An asteroid at least ${FUEL.MIN_ROID_SIZE_TO_DROP} units in size can drop a ${FUEL.DROP_AMOUNT} fuel pickup. A pilot at full fuel cannot collect it. Quake E costs ${FUEL.EMP_COST} fuel and is refused below that cost.`,
        ],
      },
      {
        heading: 'Loot and mass',
        paragraphs: [
          'Growth uses the same base health curve for every kit. When a pickup raises maximum health, it adds the same amount to current health; it does not fully repair existing damage. For a heavy kit such as Hauler, the first small mass pickup can lower its starting maximum health to the shared growth value. Fuel and laser cores do not add mass.',
          `Asteroid breaks can release shards, and a ship kill releases wreckage. A kill has base loot mass ${GROWTH.BASE_KILL_MASS} plus ${GROWTH.DROP_FRACTION * 100} percent of the destroyed ship’s mass above its ${GROWTH.BASE_MASS} starting mass, split into pellets targeting mass ${GROWTH.PELLET_MASS} each with at most ${GROWTH.MAX_PELLETS} pellets, with a global loot cap of ${GROWTH.MAX_LOOT}. Loot lasts ${seconds(GROWTH.LOOT_TTL_FRAMES)}. Mass follows a shared growth curve: greater mass raises radius and health capacity while reducing thrust and speed; the growth model soft-caps mass at ${GROWTH.SOFT_MAX_MASS}, caps size scaling at ${GROWTH.MAX_SIZE_SCALE}, and has minimum thrust and speed scales of ${GROWTH.MIN_THRUST_SCALE} and ${GROWTH.MIN_SPEED_SCALE}. Death resets the growth.`,
          `A shard has score value ${GROWTH.SHARD_SCORE}. A reflective core grants ${ASTEROID_INTERACTIONS.coreCharges} stronger laser charges with energy 2, scores ${ASTEROID_INTERACTIONS.coreScore} when collected, lasts ${seconds((ASTEROID_INTERACTIONS.coreLifetimeMs / 1000) * GAME.FPS)}, and expires on death. The shared reflection rules cap laser energy at ${ASTEROID_INTERACTIONS.maxLaserEnergy}; enhanced energy also lets a laser apply the metal hit twice.`,
        ],
      },
      {
        heading: 'Shoot a drop',
        media: 'loot',
        paragraphs: [
          `A laser can detonate a nearby loot drop when the shooter is within ${LOOT_BLAST.ARM_RANGE} units. The drop is removed and the blast reaches ${LOOT_BLAST.RADIUS} units, deals ${LOOT_BLAST.DAMAGE} damage to every nearby live hull, and includes the shooter and allies. It bypasses both E and F shields; spawn protection blocks it. It adds an outward velocity impulse of ${LOOT_BLAST.PUSH} to asteroids of size ${LOOT_BLAST.SMALL_ROID_MAX} or smaller. A hull or rock is affected when its edge reaches the blast radius.`,
        ],
      },
    ],
    related: ['quake', 'hauler', 'asteroids', 'satellites', 'combat-survival'],
    sources: [
      'shared/fuel.ts',
      'shared/shipGrowth.ts',
      'shared/lootBlast.ts',
      'shared/asteroidReflection.ts',
      'server/core/LootManager.ts',
      'server/core/GameEngine.ts',
      'src/constants/index.ts',
      'tests/unit/entities/ship-picks-up-fuel-when-flying-over-drop.test.ts',
      'tests/unit/entities/asteroids-release-fuel-when-they-break-up.test.ts',
      'tests/unit/systems/shipGrowth.test.ts',
      'tests/unit/systems/lootBlast.test.ts',
      'tests/unit/server/loot-manager.test.ts',
      'tests/unit/server/fuel-pickup-and-emp-spend.test.ts',
      'tests/integration/browser/sanity/reflective-asteroids-grant-core-upgrades.test.ts',
    ],
  },
  {
    id: 'asteroids',
    title: 'Asteroids',
    category: 'Arena',
    summary:
      'Asteroid material, size, shooter history, and reflection state determine damage, splits, rewards, and projectile behavior.',
    sections: [
      {
        heading: 'Field and materials',
        paragraphs: [
          `The server seeds the moving asteroid field with ${ROID.INITIAL_ROID_COUNT} rocks inside a ${ROID.FIELD_RADIUS} unit field radius. Surviving rocks and fragments stay in the field; splitting can raise the count above the starting population. With a human pilot present and the game running, the server reseeds only when no rocks remain. Ice and rubble have 25 health; metal has 75 health, so a normal ${DAMAGE.LASER_HIT} damage laser takes three normal hits. Metal shard mass is 0.75, while ice and rubble shard mass is 0.25.`,
          'Rubble can fragment into three uneven pieces when it breaks above size 20. Those fragments are below size 20 and do not multiply again. Ship collisions destroy an asteroid without using the laser split path. The asteroid cap is 200 rocks, so a split can be suppressed when the cap is reached.',
        ],
      },
      {
        heading: 'Cooperative splits and score',
        media: 'split',
        paragraphs: [
          `A cooperative split sends two outward pushes through nearby ships and rocks: a fast wave reaches ${SHOCKWAVE.FAST.radius} units, followed by a heavier wave reaching ${SHOCKWAVE.HEAVY.radius}. The force weakens with distance and pushes smaller bodies harder. These waves change motion without dealing direct damage; an ally can still be shoved toward a hazard.`,
          `For ice and ordinary rocks, the large-rock collaboration rule begins at size ${ROID.COLLAB_SPLIT_MIN_SIZE} or larger. Two distinct shooter IDs that hit the same biggest-class rock within a ${ROID.COLLAB_SPLIT_WINDOW_MS} millisecond collaboration window produce two fragments at 60 percent of the original size and a radial collaboration shockwave. A second hit from the same shooter destroys the rock without a collaboration split; same-shooter echoes within ${ROID.COLLAB_HIT_DEDUPE_MS} milliseconds are deduplicated. If nobody lands a qualifying second hit before the window expires, the tagged rock breaks automatically without splitting. Metal instead takes three normal hits and does not break just from waiting; rubble uses its own fragment rule. Medium and small rocks do not use the collaboration rule.`,
          'Asteroid score is based on the rock size at the break: 20 points for a large rock at least 40 units, 50 for a medium rock at least 20, and 100 for a small rock below 20. A collision break does not award the collaboration split behavior.',
        ],
      },
      {
        heading: 'Reflection and charge',
        media: 'reflection',
        paragraphs: [
          `Reflective metal clusters use the actual polygon faces for laser reflection. A cluster rock can absorb ${ASTEROID_INTERACTIONS.reflectiveEnergy} energy. Each hit adds the incoming shot energy to the rock’s charge; a reflected shot multiplies its own energy by ${ASTEROID_INTERACTIONS.laserEnergyGain}, up to ${ASTEROID_INTERACTIONS.maxLaserEnergy}. Reflection stops when the rock fills its charge, the laser reaches ${ASTEROID_INTERACTIONS.maxLaserEnergy} energy, or the shot reaches ${ASTEROID_INTERACTIONS.maxBounces} bounces; the laser lifetime cap is ${ASTEROID_INTERACTIONS.maxLaserFrames} frames. A rock that reaches its terminal reflection state breaks and can release the core reward. Reflected projectiles keep their speed magnitude and can damage the originating pilot or a same-faction pilot, while direct shots keep the friendly-fire faction filter.`,
        ],
      },
    ],
    related: ['fuel-growth', 'factions', 'combat-survival'],
    sources: [
      'server/core/AsteroidManager.ts',
      'shared/asteroidMaterials.ts',
      'shared/asteroidPhenomena.ts',
      'shared/asteroidReflection.ts',
      'src/entities/roid/roidScore.ts',
      'src/entities/roid/roidRenderer.ts',
      'src/physics/shockwave.ts',
      'server/core/GameEngine.ts',
      'src/constants/index.ts',
      'tests/unit/entities/asteroids.test.ts',
      'tests/unit/entities/asteroidPoints.test.ts',
      'tests/unit/entities/mineral-asteroids-break-with-distinct-rewards.test.ts',
      'tests/unit/entities/asteroidSplitting.test.ts',
      'tests/unit/physics/lasers-bounce-on-asteroid-faces.test.ts',
      'tests/unit/server/collaborative-asteroid-split.test.ts',
      'tests/integration/browser/collision/laser-hits-and-destroys-asteroids.test.ts',
    ],
  },
  {
    id: 'satellites',
    title: 'Satellites and pickups',
    category: 'Arena',
    summary:
      'Six hostile satellite profiles patrol the shared field, while Echo and Relay pickups become durable orbiting interceptors.',
    sections: [
      {
        heading: 'Six hostile profiles',
        media: 'satellites',
        paragraphs: [...satelliteProfiles()],
      },
      {
        heading: 'Shared satellite rules',
        paragraphs: [
          `There are up to ${SATELLITE.AMBIENT_COUNT} ambient satellites. Each has ${SATELLITE.HEALTH} health, awards ${SATELLITE.POINTS} points when destroyed, and deals ${SATELLITE.COLLISION_DAMAGE} collision damage; satellite lasers deal ${DAMAGE.LASER_HIT} damage per hit and can live for up to ${SATELLITE.PROJECTILE_MAX_FRAMES} frames. Both laser shields and spawn protection block these shots. Satellites are hostile to every faction. They orbit and drift on the shared patrol path, are repositioned when farther than ${SATELLITE.DESPAWN_DISTANCE} units from living targets, and stay within the ${SATELLITE.BOUNDARY_RADIUS} unit satellite boundary. A destroyed satellite runs an ${SATELLITE.EXPLODE_DURATION_FRAMES} frame explosion and respawns after ${SATELLITE.RESPAWN_FRAMES} frames.`,
        ],
      },
      {
        heading: 'Echo and Relay pickups',
        media: 'pickups',
        paragraphs: [
          `The field can hold ${SATELLITE_PICKUP.MAX_COUNT} loose satellite pickups: Echo and Relay are spawned separately from satellite destruction. They drift inside the ${SATELLITE_PICKUP.FIELD_RADIUS} unit pickup field. A nearest living human within ${SATELLITE_PICKUP.AUTO_COLLECT_RANGE} world units claims a loose pickup automatically and earns ${SATELLITE_PICKUP.SCORE_BONUS} score; collection does not grant a shield or spawn protection. The collected hardware orbits its owner indefinitely at least ${SATELLITE_PICKUP.ORBIT_RADIUS} units away and stays outside the hull by ${SATELLITE_PICKUP.ORBIT_GAP} units. It starts with ${SATELLITE_PICKUP.HEALTH} health and intercepts hostile player and bot shots, EO satellite lasers, and asteroid collisions. Damage reduces its health; at zero it becomes broken and respawns healthy as a loose pickup after ${SATELLITE_PICKUP.RESPAWN_FRAMES} frames, or ${seconds(SATELLITE_PICKUP.RESPAWN_FRAMES)}. Owner death or leave releases it at its current pose without restoring health.`,
        ],
      },
    ],
    related: ['factions', 'fuel-growth', 'combat-survival', 'hud-network'],
    sources: [
      'shared/eoSatellites.ts',
      'server/core/SatelliteManager.ts',
      'server/core/SatellitePickupManager.ts',
      'src/constants/index.ts',
      'tests/unit/entities/satelliteEnemies.test.ts',
      'tests/unit/entities/satelliteMath.test.ts',
      'tests/unit/entities/satellitePickups.test.ts',
      'tests/unit/entities/satellitePickupMath.test.ts',
      'tests/unit/systems/satelliteCollisions.test.ts',
      'server/core/CollisionAuthority.ts',
      'tests/unit/entities/satellite-pickups-follow-authoritative-health.test.ts',
      'tests/unit/server/satellite-pickup-scoring.test.ts',
      'tests/integration/browser/e2e/satellites-appear-and-patrol-the-arena.test.ts',
      'tests/integration/browser/e2e/player-destroys-a-satellite-with-lasers.test.ts',
      'tests/integration/browser/e2e/player-collects-orbiting-satellite-pickup.test.ts',
    ],
  },
  {
    id: 'terrain',
    title: 'Terrain and the boundary',
    category: 'Arena',
    summary:
      'Contour lines reveal slopes that change your motion. The outer wall damages ships that cross it.',
    sections: [
      {
        heading: 'Read the landscape',
        paragraphs: [
          'The arena contains hills, valleys, and saddles, with a flat spawn area at the center. Pilots in the same room share the same terrain. Slopes accelerate your ship downhill and resist travel uphill. Terrain itself does not deal damage.',
          `The circular arena is 6,000 units across with a 100 unit buffer: the damaging boundary is ${getGameBoundary().radius.toLocaleString('en-US')} units from the center. The asteroid belt uses a separate ${ROID.FIELD_RADIUS} unit radius. Crossing the boundary deals ${DAMAGE.BOUNDARY_COLLISION} damage per impact; a healthy heavy hull can survive the first hit, but staying outside remains dangerous.`,
        ],
      },
      {
        heading: 'Slope and contours',
        media: 'terrain',
        paragraphs: [
          'Contour lines are closest together on steep slopes and farther apart on gentle ground. Faint numbers mark relative elevations, including negative values in valleys. Watch the contours and your drift to tell uphill from downhill. Normal hull and mass speed limits still apply, and bots feel the same slope force. Lasers keep their normal motion; glints where shots cross contours are visual feedback, with no terrain reflection or extra damage.',
        ],
      },
    ],
    related: ['controls', 'asteroids', 'combat-survival', 'hud-network'],
    sources: [
      'src/physics/terrain/terrainConfig.ts',
      'src/physics/terrain/heightfield.ts',
      'src/physics/terrain/slopeForce.ts',
      'src/physics/terrain/contours.ts',
      'src/physics/terrain/terrainSession.ts',
      'src/physics/boundary.ts',
      'shared-types.ts',
      'tests/unit/systems/contourLaser.test.ts',
    ],
  },
  {
    id: 'combat-survival',
    title: 'Damage, scoring, and survival',
    category: 'Combat',
    summary:
      'Know what each shield stops, how much a hit costs, and what you keep when you respawn.',
    sections: [
      {
        heading: 'Firing while moving',
        paragraphs: [
          `Shots leave the nose and inherit your ship’s velocity, so a moving ship changes their flight path. Hold fire to repeat shots at your kit’s interval. You can have up to ${SHIP.MAX_LASERS} local shots at once; reaching that limit temporarily prevents more shots, including extra rounds from a Skirmisher burst. A regular shot deals ${DAMAGE.LASER_HIT} damage; reflected or core-powered shots multiply that damage by their energy. Local shots appear immediately and stay visible while the server confirms them; the server still controls hits and removal.`,
        ],
      },
      {
        heading: 'Damage and protection',
        media: 'shield',
        paragraphs: [
          `A normal laser hit deals 25 damage. The player collision rule deals 20 damage per second in 50 millisecond ticks. An asteroid impact deals 25 damage and destroys the rock. A boundary impact deals 100 damage; a hull with more health can survive the first hit. The regular F shield reflects hostile lasers for ${SHIELD.DURATION_SECONDS} seconds and does not stop environmental collisions. Warden’s F shield lasts ${SHIELD.WARDEN_DURATION_SECONDS} seconds; its E projection lasts ${seconds(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES)}, and both reflect hostile lasers without stopping collisions. Exploding loot deals 40 damage through both shields, including to allies and the shooter. Spawn protection blocks that blast too.`,
        ],
      },
      {
        heading: 'Lives and respawn',
        paragraphs: [
          'A human starts with 3 lives and a score of 0. A death decrements one life; the last life reaching zero enters game over. Explosion stops active thrust and turning; held controls resume when the server confirms your respawn. The explosion lasts 18 frames and the respawn delay is 18 frames. A respawn restores the kit’s health, starts with 50 fuel, resets mass growth, clears shield and upgrade state, and grants 180 frames, or 3 seconds, of spawn protection. Human respawns are placed randomly within 80 percent of the asteroid field radius, which is 1,200 units; bots always respawn.',
          'Health regenerates at 1 point per second after a 5 second real-damage delay. Score survives a respawn. Kill loot is emitted from the destroyed ship. The visible death message includes the recorded death cause, and the final-life state shows the game-over overlay.',
        ],
      },
      {
        heading: 'Score values',
        paragraphs: [
          'A human kill is worth 200 points and a bot kill is worth 50. A satellite is worth 75. Asteroid breaks are worth 20 for a large rock, 50 for a medium rock, and 100 for a small rock; a shard pickup is worth 5. A collected satellite pickup adds 50.',
        ],
      },
    ],
    related: ['controls', 'factions', 'fuel-growth', 'satellites', 'hud-network'],
    sources: [
      'src/constants/index.ts',
      'src/entities/ship/Ship.ts',
      'src/entities/laser/laserUtils.ts',
      'src/entities/laser/AuthoritativeProjectileField.ts',
      'src/entities/ship/shipShield.ts',
      'server/core/EntityManager.ts',
      'server/core/combatScoring.ts',
      'shared/combat.ts',
      'server/core/GameEngine.ts',
      'server/core/LootManager.ts',
      'src/utils/deathCause.ts',
      'tests/unit/entities/shipDamage.test.ts',
      'tests/unit/entities/shipLifecycle.test.ts',
      'tests/unit/entities/combatDamage.test.ts',
      'tests/unit/network/pilots-reconcile-authoritative-bolts.test.ts',
      'tests/unit/scenarios/combat/wall-or-roid-hit-explodes-then-respawns-without-freeze.test.ts',
      'tests/unit/scenarios/combat/a-laser-hit-at-low-health-explodes-the-ship-immediately.test.ts',
      'tests/integration/browser/e2e/ship-respawns-randomly-after-boundary-death.test.ts',
      'tests/integration/browser/e2e/ship-respawns-randomly-after-asteroid-death.test.ts',
    ],
  },
  {
    id: 'factions',
    title: 'Factions and friendly fire',
    category: 'Combat',
    summary:
      'ION and EMBER protect allies from direct shots and ship collision damage. Environmental hazards still threaten everyone.',
    sections: [
      {
        heading: 'Side assignment',
        paragraphs: [
          'Players are assigned to ION or EMBER when they join, with the balancing helper filling the smaller side and resolving a tie in favor of ION. Faction is independent of ship kit. The HUD shows the side label and mark, while hull colors continue to identify the ship role.',
        ],
      },
      {
        heading: 'Damage rules',
        paragraphs: [
          'Once both ships have a side, direct shots and ship collision damage from the same faction do no damage; hostile ships can hurt you. An unassigned side does not receive that same-faction protection. Asteroids, boundary damage, and other environmental sources remain dangerous regardless of side. Satellites are hostile to every faction. A reflected laser is marked as a ricochet and can damage its originating pilot or a same-faction pilot after it bounces. Exploding loot also hurts allies and the shooter. Hauler E skips allied ships, but Quake can push allies without damaging them.',
        ],
      },
      {
        heading: 'Bots',
        paragraphs: [
          'Orange hulls are bots. They choose living hostile human pilots, lead moving targets when aiming, and patrol when there is no target. They share the faction rules and keep respawning after destruction. Their orange color identifies a bot, not its side: check the faction mark before assuming it is hostile.',
        ],
      },
    ],
    related: ['controls', 'asteroids', 'satellites', 'combat-survival', 'hud-network'],
    sources: [
      'shared/factions.ts',
      'server/ai/botController.ts',
      'src/entities/player/softFactions.ts',
      'server/core/combatScoring.ts',
      'shared/combat.ts',
      'server/core/GameEngine.ts',
      'shared/asteroidReflection.ts',
      'tests/unit/shared/factions.test.ts',
      'tests/unit/shared/combat.test.ts',
      'tests/unit/server/factions-teamwork.test.ts',
      'tests/unit/scenarios/combat/same-side-shots-do-not-hurt-once-sides-are-set.test.ts',
    ],
  },
  {
    id: 'hud-network',
    title: 'HUD and the shared world',
    category: 'Systems',
    summary:
      'Read lives, fuel, health, nearby threats, and scores. Understand what to do if the connection drops.',
    sections: [
      {
        heading: 'What the HUD shows',
        paragraphs: [
          'Before entering a game, set your pilot name, choose a kit, and use the Sound checkbox on the title screen to enable or mute audio.',
          'The HUD shows lives as kit hull icons, score, faction label and mark, kit name, and a fuel bar. Desktop layouts include a leaderboard of up to 10 rows and a minimap; touch layouts use a compact leaderboard and an adaptive minimap. The minimap shows your ship, other human pilots, bot pilots, asteroids, loot drops, hostile satellites, loose pickups, and orbiting pickups inside the arena ring. Compact marks follow each entity’s current position; destroyed or collected objects disappear when the shared state removes them. Slate squares mark asteroids; cream squares and diamonds mark wreckage and shards, green crosses mark fuel, yellow slashed diamonds mark laser cores, purple crosses mark satellites, and amber circles and diamonds mark loose and orbiting pickups. Ship headings and faction marks keep pilots identifiable above the world marks. Kill and pickup messages appear in the center for 120 frames, or 2 seconds. A health capsule appears above a damaged ship; use its remaining fill to judge hull health. Your own hull is mint, other human pilots are sky blue, and bots are orange. Faction marks identify allies separately from those colors.',
        ],
      },
      {
        heading: 'Display refresh rate',
        paragraphs: [
          'Flight, projectiles, shields, and HUD message timers advance at 60 simulation steps per second. A faster display does not increase ship speed or shorten cooldowns. After a visible stall, the client catches up at most one second of simulation; switching back from a hidden tab instead resumes from current server state.',
        ],
      },
      {
        heading: 'Connection interruptions',
        paragraphs: [
          'Keep the game tab up to date. If the server asks you to update the client, reload the page before joining again. Older game versions cannot join.',
          'Switching away from the game releases held movement and fire controls. On return, the client requests current server state and resumes drawing without replaying the time the tab was hidden.',
          'The game automatically tries to reconnect after a lost connection. During an interruption, the local view may lag behind the shared world; wait for the connection to recover before relying on a pickup or hit result. If joining fails or reconnect attempts are exhausted, the game returns to the title screen. Select Enter Game to try again. A full reload can start a new session.',
        ],
      },
    ],
    related: ['field-manual', 'controls', 'combat-survival', 'factions'],
    sources: [
      'shared/gameClock.ts',
      'src/core/eventLoop.ts',
      'src/core/gameController.ts',
      'src/rendering/hud/gameInfo.ts',
      'src/ui/mainMenu.ts',
      'src/entities/ship/shipRenderer.ts',
      'src/rendering/hud/lives.ts',
      'src/rendering/hud/leaderboard.ts',
      'src/rendering/hud/minimap.ts',
      'src/rendering/hud/hudLayout.ts',
      'src/network/services/ConnectionManager.ts',
      'server/services/GameStateBroadcaster.ts',
      'shared-types.ts',
      'docs/protocol/snapshot-v1.md',
      'tests/unit/rendering/hudLayout.test.ts',
      'tests/unit/systems/hudReadability.test.ts',
      'tests/unit/network/pilots-recover-complete-snapshots.test.ts',
      'tests/unit/network/asteroidFieldSync.test.ts',
    ],
  },
];
