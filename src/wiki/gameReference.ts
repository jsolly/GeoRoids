import { KILL_SCORE } from '../../server/core/combatScoring';
import { asteroidShardMass } from '../../shared/asteroidMaterials';
import { ASTEROID_INTERACTIONS } from '../../shared/asteroidPhenomena';
import { shipShipTickDamage } from '../../shared/combat';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../shared/constants/health';
import { SATELLITE_PROFILES } from '../../shared/eoSatellites';
import { MAX_CATCH_UP_TICKS } from '../../shared/gameClock';
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
import { getShipKit, SHIP_ABILITY, SHIP_KIT_IDS, type ShipKitId } from '../entities/ship/shipKits';
import { SKIRMISHER_RING_COUNT } from '../entities/ship/skirmisherRing';
import { getGameBoundary } from '../physics/boundary';

function seconds(frames: number): string {
  return `${frames / GAME.FPS} seconds`;
}

function frameValue(frames: number): string {
  return `${frames} frames (${seconds(frames)})`;
}

function shipStats(id: ShipKitId): string {
  const kit = getShipKit(id);
  const cooldown = SHIP_ABILITY.COOLDOWN_FRAMES[id];
  return `${kit.name}: ${kit.maxHealth} maximum health, size ${kit.size}, thrust ${kit.thrust}, maximum velocity ${kit.maxVelocity}, ${kit.turnSpeed} degree per second turn rate, ${kit.shotCooldown} millisecond shot interval, and E cooldown ${frameValue(cooldown)}.`;
}

function satelliteProfiles(): string[] {
  const patterns: Record<string, string> = {
    steady: 'a steady, aimed single shot',
    'wide-sweep': 'a three-shot fan that sweeps a wide angle',
    'spin-burst': 'a rotating six-shot burst',
    'weather-beam': 'four fast shots along one narrow line',
    'radar-sweep': 'a two-shot sweep',
    'precision-stab': 'a fast, tightly aimed single shot',
  };
  return SATELLITE_PROFILES.map(
    (profile) =>
      `${profile.displayName}: ${patterns[profile.shotPattern] ?? profile.shotPattern}; volley every ${(profile.cadenceFrames / GAME.FPS).toFixed(2)} seconds (${profile.cadenceFrames} frames); projectile speed ${profile.speedMultiplier}× normal satellite shot speed.`
  );
}

export const gameReference: Record<string, { heading: string; paragraphs: string[] }[]> = {
  'field-manual': [
    {
      heading: 'Current values',
      paragraphs: [
        `Starting lives: ${GAME.START_LIVES}; starting score: ${GAME.STARTING_SCORE}. Ship kits: ${SHIP_KIT_IDS.length} (${SHIP_KIT_IDS.map((id) => getShipKit(id).name).join(', ')}).`,
        `Ambient satellite profiles: ${SATELLITE_PROFILES.length}.`,
      ],
    },
  ],
  controls: [
    {
      heading: 'Movement values',
      paragraphs: [
        `Shared movement defaults: thrust ${SHIP.THRUST}, maximum velocity ${SHIP.MAX_VELOCITY}, turn rate ${SHIP.TURN_SPEED} degrees per second, and coasting friction ${GAME.FRICTION}. The simulation runs at ${GAME.FPS} frames per second.`,
      ],
    },
  ],
  dart: [
    {
      heading: 'Dart values',
      paragraphs: [shipStats('dart')],
    },
    {
      heading: 'Ability and shield values',
      paragraphs: [
        `E adds ${SHIP_ABILITY.DASH_BOOST} forward velocity. The regular F shield lasts ${SHIELD.DURATION_SECONDS} seconds and its cooldown is ${SHIELD.COOLDOWN_SECONDS} seconds.`,
      ],
    },
  ],
  hauler: [
    {
      heading: 'Hauler values',
      paragraphs: [shipStats('hauler')],
    },
    {
      heading: 'Harpoon values',
      paragraphs: [
        `The combat harpoon has a minimum range of ${SHIP_ABILITY.HARPOON_RANGE} units, lasts ${frameValue(SHIP_ABILITY.HARPOON_FRAMES)} for nearby catches, and applies pull strength ${SHIP_ABILITY.HARPOON_PULL} with distance falloff.`,
        `A clear momentum collision course is accepted within a ${Math.round((Math.acos(SHIP_ABILITY.HARPOON_PATH_ALIGNMENT) * 180) / Math.PI)}-degree path and keeps the rock's heading, boosting it to at least ${SHIP_ABILITY.HARPOON_SLING_SPEED} units per frame while preserving faster momentum. Other rocks reel toward the Hauler at a relative target of ${SHIP_ABILITY.HARPOON_REEL_SPEED} units per frame with ${SHIP_ABILITY.HARPOON_REEL_ACCELERATION} units per-frame acceleration, then release near the hull with a ${SHIP_ABILITY.HARPOON_RELEASE_GAP} unit safety gap toward a predicted enemy within ${frameValue(SHIP_ABILITY.HARPOON_INTERCEPT_FRAMES)}.`,
      ],
    },
  ],
  warden: [
    {
      heading: 'Warden values',
      paragraphs: [shipStats('warden')],
    },
    {
      heading: 'Ability and shield values',
      paragraphs: [
        `E projects a reflective shield to an ally for ${frameValue(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES)}, within ${SHIP_ABILITY.SHIELD_PROJECTION_RANGE} units between hull edges. The Warden E cooldown is ${frameValue(SHIP_ABILITY.COOLDOWN_FRAMES.warden)}. The Warden F shield lasts ${SHIELD.WARDEN_DURATION_SECONDS} seconds and its cooldown is ${SHIELD.COOLDOWN_SECONDS} seconds.`,
      ],
    },
  ],
  skirmisher: [
    {
      heading: 'Skirmisher values',
      paragraphs: [shipStats('skirmisher')],
    },
    {
      heading: 'Ring values',
      paragraphs: [
        `E creates ${SKIRMISHER_RING_COUNT} evenly spaced shots around the hull. The local laser cap for regular Space shots is ${SHIP.MAX_LASERS}.`,
      ],
    },
  ],
  quake: [
    {
      heading: 'Quake values',
      paragraphs: [shipStats('quake')],
    },
    {
      heading: 'Pulse and fuel values',
      paragraphs: [
        `E costs ${FUEL.EMP_COST} fuel, reaches ${SHIP_ABILITY.SHOCK_RADIUS} units, and applies force ${SHIP_ABILITY.SHOCK_FORCE} with distance falloff and an edge force ratio of ${SHIP_ABILITY.SHOCK_EDGE_FORCE_RATIO}. It pushes nearby physical objects without direct damage. A life starts with ${FUEL.START} fuel and the tank maximum is ${FUEL.MAX}.`,
      ],
    },
  ],
  'fuel-growth': [
    {
      heading: 'Fuel values',
      paragraphs: [
        `Fuel per life: ${FUEL.START} start and ${FUEL.MAX} maximum. A rock at least ${FUEL.MIN_ROID_SIZE_TO_DROP} units in size can drop ${FUEL.DROP_AMOUNT} fuel. Quake E costs ${FUEL.EMP_COST}.`,
      ],
    },
    {
      heading: 'Growth and loot values',
      paragraphs: [
        `Growth starts at mass ${GROWTH.BASE_MASS}, soft-caps at ${GROWTH.SOFT_MAX_MASS}, caps size scaling at ${GROWTH.MAX_SIZE_SCALE}, and bottoms out at thrust scale ${GROWTH.MIN_THRUST_SCALE} and speed scale ${GROWTH.MIN_SPEED_SCALE}. A kill always contributes at least ${GROWTH.BASE_KILL_MASS} mass, converts ${GROWTH.DROP_FRACTION * 100}% of excess mass, targets ${GROWTH.PELLET_MASS} mass per pellet, allows at most ${GROWTH.MAX_PELLETS} pellets, and caps live loot at ${GROWTH.MAX_LOOT}. Loot lasts ${seconds(GROWTH.LOOT_TTL_FRAMES)}.`,
        `Shard score: ${GROWTH.SHARD_SCORE}. A reflective core grants ${ASTEROID_INTERACTIONS.coreCharges} charges, scores ${ASTEROID_INTERACTIONS.coreScore}, lasts ${ASTEROID_INTERACTIONS.coreLifetimeMs / 1000} seconds, and uses a maximum laser energy of ${ASTEROID_INTERACTIONS.maxLaserEnergy}.`,
      ],
    },
    {
      heading: 'Loot blast values',
      paragraphs: [
        `A laser can arm a drop within ${LOOT_BLAST.ARM_RANGE} units. The blast radius is ${LOOT_BLAST.RADIUS} units, damage is ${LOOT_BLAST.DAMAGE}, the asteroid push is ${LOOT_BLAST.PUSH}, and the affected small-asteroid size is at most ${LOOT_BLAST.SMALL_ROID_MAX}.`,
      ],
    },
  ],
  asteroids: [
    {
      heading: 'Field and material values',
      paragraphs: [
        `The starting field has ${ROID.INITIAL_ROID_COUNT} rocks inside a ${ROID.FIELD_RADIUS} unit radius. Ice and rubble have ${DAMAGE.LASER_HIT} health; metal has ${DAMAGE.LASER_HIT * 3}. Metal shard mass is ${asteroidShardMass('metal')}; ice and rubble shard mass is ${asteroidShardMass('ice')}.`,
      ],
    },
    {
      heading: 'Split and score values',
      paragraphs: [
        `The fast collaboration shockwave reaches ${SHOCKWAVE.FAST.radius} units with impulse ${SHOCKWAVE.FAST.impulse}; the heavy wave reaches ${SHOCKWAVE.HEAVY.radius} units with impulse ${SHOCKWAVE.HEAVY.impulse}.`,
        `Large-rock collaboration starts at size ${ROID.COLLAB_SPLIT_MIN_SIZE}; the collaboration window is ${ROID.COLLAB_SPLIT_WINDOW_MS} milliseconds and same-shooter deduplication lasts ${ROID.COLLAB_HIT_DEDUPE_MS} milliseconds. Asteroid scores are large ${ROID.POINTS_LARGE}, medium ${ROID.POINTS_MEDIUM}, and small ${ROID.POINTS_SMALL}.`,
      ],
    },
    {
      heading: 'Reflection values',
      paragraphs: [
        `Reflective metal absorbs ${ASTEROID_INTERACTIONS.reflectiveEnergy} energy. Each reflected shot multiplies energy by ${ASTEROID_INTERACTIONS.laserEnergyGain}, up to ${ASTEROID_INTERACTIONS.maxLaserEnergy}; the bounce limit is ${ASTEROID_INTERACTIONS.maxBounces} and the laser lifetime cap is ${ASTEROID_INTERACTIONS.maxLaserFrames} frames.`,
      ],
    },
  ],
  satellites: [
    {
      heading: 'Profile values',
      paragraphs: satelliteProfiles(),
    },
    {
      heading: 'Satellite values',
      paragraphs: [
        `Ambient count: ${SATELLITE.AMBIENT_COUNT}; health: ${SATELLITE.HEALTH}; destruction score: ${SATELLITE.POINTS}; collision damage: ${SATELLITE.COLLISION_DAMAGE}; projectile lifetime: ${SATELLITE.PROJECTILE_MAX_FRAMES} frames. Satellites are repositioned beyond ${SATELLITE.DESPAWN_DISTANCE} units and stay within a ${SATELLITE.BOUNDARY_RADIUS} unit boundary. Explosion duration is ${SATELLITE.EXPLODE_DURATION_FRAMES} frames and respawn delay is ${SATELLITE.RESPAWN_FRAMES} frames.`,
      ],
    },
    {
      heading: 'Pickup values',
      paragraphs: [
        `Loose pickup maximum: ${SATELLITE_PICKUP.MAX_COUNT}; pickup field radius: ${SATELLITE_PICKUP.FIELD_RADIUS}; collection score: ${SATELLITE_PICKUP.SCORE_BONUS}; automatic collection range: ${SATELLITE_PICKUP.AUTO_COLLECT_RANGE}; health: ${SATELLITE_PICKUP.HEALTH}; minimum owner orbit radius: ${SATELLITE_PICKUP.ORBIT_RADIUS}; hull gap: ${SATELLITE_PICKUP.ORBIT_GAP}; broken pickup respawn: ${frameValue(SATELLITE_PICKUP.RESPAWN_FRAMES)}.`,
      ],
    },
  ],
  terrain: [
    {
      heading: 'Boundary values',
      paragraphs: [
        `The damaging boundary radius is ${getGameBoundary().radius.toLocaleString('en-US')} units. The asteroid field radius is ${ROID.FIELD_RADIUS} units and a boundary impact deals ${DAMAGE.BOUNDARY_COLLISION} damage.`,
      ],
    },
  ],
  'combat-survival': [
    {
      heading: 'Combat values',
      paragraphs: [
        `A ship can have ${SHIP.MAX_LASERS} local lasers. A normal laser hit deals ${DAMAGE.LASER_HIT}; player collision damage is ${DAMAGE.PLAYER_COLLISION_PER_SECOND} per second in ${DAMAGE.PLAYER_COLLISION_INTERVAL_MS} millisecond ticks (${shipShipTickDamage()} damage per tick); an asteroid collision deals ${DAMAGE.ASTEROID_COLLISION}; a boundary impact deals ${DAMAGE.BOUNDARY_COLLISION}; and exploding loot deals ${LOOT_BLAST.DAMAGE}.`,
        `The regular F shield lasts ${SHIELD.DURATION_SECONDS} seconds with a ${SHIELD.COOLDOWN_SECONDS} second cooldown. Warden F lasts ${SHIELD.WARDEN_DURATION_SECONDS} seconds and its E projection lasts ${frameValue(SHIP_ABILITY.SHIELD_PROJECTION_FRAMES)}. Spawn protection lasts ${frameValue(SHIP.INVINCIBILITY_DURATION_FRAMES)}.`,
      ],
    },
    {
      heading: 'Lifecycle and health values',
      paragraphs: [
        `Humans start with ${GAME.START_LIVES} lives and score ${GAME.STARTING_SCORE}. Explosion duration is ${frameValue(SHIP.EXPLODE_DURATION_FRAMES)}; respawn delay is ${frameValue(SHIP.RESPAWN_DELAY_FRAMES)}; human respawns use the asteroid field radius. Respawn restores ${FUEL.START} fuel out of ${FUEL.MAX}.`,
        `Health regeneration is ${SHIP.HEALTH_REGEN_RATE} point per second (${calculateHealthRegenPerFrame()} per frame) after a ${SHIP.HEALTH_REGEN_DELAY} second delay (${calculateHealthRegenDelayFrames()} frames).`,
      ],
    },
    {
      heading: 'Score values',
      paragraphs: [
        `Kill score: human ${KILL_SCORE.human}, bot ${KILL_SCORE.bot}. Satellite score: ${SATELLITE.POINTS}. Asteroid score: large ${ROID.POINTS_LARGE}, medium ${ROID.POINTS_MEDIUM}, small ${ROID.POINTS_SMALL}. Shard score: ${GROWTH.SHARD_SCORE}. Satellite pickup score: ${SATELLITE_PICKUP.SCORE_BONUS}.`,
      ],
    },
  ],
  'hud-network': [
    {
      heading: 'Display and HUD values',
      paragraphs: [`The shared simulation runs at ${GAME.FPS} frames per second.`],
    },
    {
      heading: 'Connection and protocol values',
      paragraphs: [
        `The client allows at most ${MAX_CATCH_UP_TICKS} catch-up frames after a stall.`,
      ],
    },
  ],
};
