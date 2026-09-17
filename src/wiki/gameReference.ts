import { asteroidShardMass } from '../../shared/asteroidMaterials';
import { ASTEROID_INTERACTIONS } from '../../shared/asteroidPhenomena';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../shared/constants/health';
import { SATELLITE_PROFILES } from '../../shared/eoSatellites';
import { EXPLORATION_RANGE } from '../../shared/exploration';
import { FURNACES, furnaceReward } from '../../shared/furnaces';
import { MAX_CATCH_UP_TICKS } from '../../shared/gameClock';
import { LOOT_BLAST } from '../../shared/lootBlast';
import { PLAYER_MOTION } from '../../shared/playerMotion';
import { GROWTH } from '../../shared/shipGrowth';
import { WORLD } from '../../shared/world';
import type { ShipKitId } from '../../shared-types';
import { DAMAGE, GAME, LASER, ROID, SATELLITE_PICKUP, SHIP, SHOCKWAVE } from '../constants';
import { getShipKit, SHIP_ABILITY, SHIP_KIT_IDS } from '../entities/ship/shipKits';
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
  return `${kit.name}: ${kit.maxHealth} maximum health, size ${kit.size}, thrust ${kit.thrust}, maximum velocity ${kit.maxVelocity}, boost multiplier ${kit.boostMultiplier}, ${kit.turnSpeed} degree per second turn rate, ${kit.shotCooldown} millisecond shot interval, and E cooldown ${frameValue(cooldown)}.`;
}

function satelliteProfiles(): string[] {
  return SATELLITE_PROFILES.map(
    (profile) => `${profile.displayName}: collectible ${profile.typeId} hull (${profile.assetKey}).`
  );
}

const starterFurnaces = FURNACES.slice(0, 3);

export const gameReference: Record<string, { heading: string; paragraphs: string[] }[]> = {
  'field-manual': [
    {
      heading: 'Current values',
      paragraphs: [
        `Starting lives: ${GAME.START_LIVES}; starting score: ${GAME.STARTING_SCORE}. Ship kits: ${SHIP_KIT_IDS.length} (${SHIP_KIT_IDS.map((id) => getShipKit(id).name).join(', ')}).`,
        `Earth-observation pickup hulls: ${SATELLITE_PROFILES.length}.`,
        `Starter furnaces: ${starterFurnaces.map((furnace) => furnace.name).join(', ')}; ${FURNACES.length - starterFurnaces.length} regional Works sites fill the ${WORLD.radius.toLocaleString('en-US')}-unit world.`,
        `After game over, a fresh flight starts with ${GAME.START_LIVES} lives and score ${GAME.STARTING_SCORE}. A disconnect shorter than ${PLAYER_MOTION.returnToShipMs / 1000} seconds returns you to the same ship; a longer gap starts a new flight with the score you still have. The persistent universe, exploration chart, and delivered progress remain until the UTC calendar month ends, when scores and the shared world both reset.`,
      ],
    },
  ],
  controls: [
    {
      heading: 'Movement values',
      paragraphs: [
        `Automatic movement defaults: thrust ${SHIP.THRUST}, maximum velocity ${SHIP.MAX_VELOCITY}, and turn rate ${SHIP.TURN_SPEED} degrees per second. Terrain and mass still affect flight. The simulation runs at ${GAME.FPS} frames per second.`,
        `Shift or the Boost button multiplies cruise speed and thrust by ${getShipKit('surveyor').boostMultiplier} for Surveyor and ${getShipKit('hauler').boostMultiplier} for Hauler. Tap or press again to return to the shared cruise speed.`,
        `Movement and projectiles are ${Math.round((1 - GAME.MOTION_SCALE) * 100)}% slower. Turning, firing cadence, and ability cooldowns keep their responsiveness. Shots still reach the same distance, but take longer to get there.`,
      ],
    },
  ],
  surveyor: [
    {
      heading: 'Surveyor values',
      paragraphs: [shipStats('surveyor')],
    },
    {
      heading: 'Ability and exploration values',
      paragraphs: [
        `E runs a ${seconds(SHIP_ABILITY.SCAN_FRAMES)} mineral scan within ${SHIP_ABILITY.SCAN_RANGE} units. The scan cooldown is ${seconds(SHIP_ABILITY.COOLDOWN_FRAMES.surveyor)}; each identified rock keeps its classification and records the Surveyor player ID for a later furnace delivery.`,
        `Passive shared exploration reaches ${EXPLORATION_RANGE.surveyor} world units for Surveyor and ${EXPLORATION_RANGE.hauler} for Hauler; revealed cells persist for the match.`,
      ],
    },
  ],
  hauler: [
    {
      heading: 'Hauler values',
      paragraphs: [shipStats('hauler')],
    },
    {
      heading: 'Tow and mining values',
      paragraphs: [
        `Hauler lasers deal ${SHIP_ABILITY.ASTEROID_DAMAGE_MULTIPLIER} times normal mining damage to metal asteroids and cooperative large rocks. The ability has no ship-targeting mode.`,
        `E attaches the equipped Hauler utility within a fixed ${SHIP_ABILITY.HARPOON_RANGE}-unit hull gap. Resource Tap finishes after ${seconds(SHIP_ABILITY.TAP_EXTRACT_FRAMES)} and leaves the rock intact. Tow Cable keeps the rock's velocity and corrects only when stretched; a successful attachment starts the ${seconds(SHIP_ABILITY.COOLDOWN_FRAMES.hauler)} cooldown, while E again releases the tether immediately. Towed cargo that overlaps another asteroid or another ship uses the ordinary collision break and detaches the cable.`,
        `Furnace intakes are ${starterFurnaces[0]?.radius ?? 0} units. At size 25, delivery rewards are ice ${furnaceReward({ material: 'ice', size: 25 })}, metal ${furnaceReward({ material: 'metal', size: 25 })}, and rubble ${furnaceReward({ material: 'rubble', size: 25 })} points for the Hauler and each recorded Surveyor.`,
      ],
    },
  ],
  'loot-growth': [
    {
      heading: 'Growth and loot values',
      paragraphs: [
        `Growth starts at mass ${GROWTH.BASE_MASS}, soft-caps at ${GROWTH.SOFT_MAX_MASS}, caps size scaling at ${GROWTH.MAX_SIZE_SCALE}, and bottoms out at thrust scale ${GROWTH.MIN_THRUST_SCALE} and speed scale ${GROWTH.MIN_SPEED_SCALE}. An environmental ship death always contributes at least ${GROWTH.BASE_KILL_MASS} mass, converts ${GROWTH.DROP_FRACTION * 100}% of excess mass, targets ${GROWTH.PELLET_MASS} mass per pellet, allows at most ${GROWTH.MAX_PELLETS} pellets, and caps live loot at ${GROWTH.MAX_LOOT}. Loot lasts ${seconds(GROWTH.LOOT_TTL_FRAMES)}.`,
        `Wreckage and shard drops have radius ${GROWTH.LOOT_RADIUS}. Tap canisters have radius ${GROWTH.TAP_LOOT_RADIUS}, mass ${GROWTH.TAP_LOOT_MASS}, and score ${GROWTH.TAP_LOOT_SCORE}. A living ship magnetizes ordinary drops within ${GROWTH.LOOT_MAGNET_RANGE} units with acceleration ${GROWTH.LOOT_MAGNET_ACCEL}. Tap loot uses range ${GROWTH.TAP_LOOT_MAGNET_RANGE} and acceleration ${GROWTH.TAP_LOOT_MAGNET_ACCEL} toward a Hauler. Pickup overlap uses each kit's hull radius, scaled by mass, plus the drop radius.`,
        `Shard score: ${GROWTH.SHARD_SCORE}. A reflective core grants ${ASTEROID_INTERACTIONS.coreCharges} charges, scores ${ASTEROID_INTERACTIONS.coreScore}, lasts ${ASTEROID_INTERACTIONS.coreLifetimeMs / 1000} seconds, and uses a maximum laser energy of ${ASTEROID_INTERACTIONS.maxLaserEnergy}.`,
      ],
    },
    {
      heading: 'Loot blast values',
      paragraphs: [
        `A laser can arm a drop within ${LOOT_BLAST.ARM_RANGE} units. The shot-triggered blast radius is ${LOOT_BLAST.RADIUS} units, leaves crew hulls unharmed, applies an asteroid push of ${LOOT_BLAST.PUSH}, and affects small asteroids up to size ${LOOT_BLAST.SMALL_ROID_MAX}.`,
      ],
    },
  ],
  asteroids: [
    {
      heading: 'Field and material values',
      paragraphs: [
        `The procedural field uses ${WORLD.sectorSize.toLocaleString('en-US')}-unit sectors with ${WORLD.depositsPerSector} deterministic deposits per sector inside the ${WORLD.radius.toLocaleString('en-US')}-unit world. Ice and rubble have ${DAMAGE.LASER_HIT} health; metal has ${DAMAGE.LASER_HIT * 3}. Metal shard mass is ${asteroidShardMass('metal')}; ice and rubble shard mass is ${asteroidShardMass('ice')}.`,
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
        `The lethal boundary radius is ${getGameBoundary().radius.toLocaleString('en-US')} units. The asteroid field radius is ${ROID.FIELD_RADIUS} units and boundary contact destroys a vulnerable ship regardless of hull health. Asteroids and lasers bounce inward; after a bounce, a laser damages any live ship it hits.`,
      ],
    },
  ],
  'combat-survival': [
    {
      heading: 'Combat values',
      paragraphs: [
        `A ship can have ${SHIP.MAX_LASERS} local lasers. Laser projectiles use hit radius ${LASER.HIT_RADIUS}; a normal laser hit deals ${DAMAGE.LASER_HIT}. Unbounced ship lasers, ship-to-ship ramming, tow cables, and shot-triggered loot blasts leave crew hulls unharmed. After a bounce, a laser deals ${DAMAGE.LASER_HIT} times its energy to any live ship it hits, including its owner, and is consumed. An environmental asteroid impact deals ${DAMAGE.ASTEROID_COLLISION}; a towed rock uses that same impact against another ship and then breaks. Boundary contact destroys a vulnerable ship regardless of hull health.`,
        `Spawn protection lasts ${frameValue(SHIP.INVINCIBILITY_DURATION_FRAMES)}.`,
      ],
    },
    {
      heading: 'Lifecycle and health values',
      paragraphs: [
        `Players start with ${GAME.START_LIVES} lives and score ${GAME.STARTING_SCORE}. Explosion duration is ${frameValue(SHIP.EXPLODE_DURATION_FRAMES)}; respawn delay is ${frameValue(SHIP.RESPAWN_DELAY_FRAMES)}; respawns use the nearest furnace with a 180-unit offset and skip completed sectors. Score survives respawn and leave until game over or the UTC calendar month ends. A brief disconnect of up to ${PLAYER_MOTION.returnToShipMs / 1000} seconds returns you to the same ship; a longer gap starts a new flight with that score; game over starts a new flight at score ${GAME.STARTING_SCORE}.`,
        `Health regeneration is ${SHIP.HEALTH_REGEN_RATE} point per second (${calculateHealthRegenPerFrame()} per frame) after a ${SHIP.HEALTH_REGEN_DELAY} second delay (${calculateHealthRegenDelayFrames()} frames).`,
      ],
    },
    {
      heading: 'Score values',
      paragraphs: [
        `Asteroid score: large ${ROID.POINTS_LARGE}, medium ${ROID.POINTS_MEDIUM}, small ${ROID.POINTS_SMALL}. Shard score: ${GROWTH.SHARD_SCORE}. Satellite pickup score: ${SATELLITE_PICKUP.SCORE_BONUS}. Furnace delivery at size 25 awards ice ${furnaceReward({ material: 'ice', size: 25 })}, metal ${furnaceReward({ material: 'metal', size: 25 })}, or rubble ${furnaceReward({ material: 'rubble', size: 25 })} to each contributor.`,
      ],
    },
  ],
  'hud-network': [
    {
      heading: 'Display and HUD values',
      paragraphs: [
        `The shared simulation runs at ${GAME.FPS} frames per second. The local minimap uses a ${WORLD.minimapRadius}-unit radar radius; the full-screen universe map uses the shared exploration chart and keeps discovered furnaces and other important assets visible across the ${WORLD.radius.toLocaleString('en-US')}-unit world. M or the on-screen Map button opens the overview; M, Escape, or Close returns to flight.`,
      ],
    },
    {
      heading: 'Connection and protocol values',
      paragraphs: [
        `The client allows at most ${MAX_CATCH_UP_TICKS} catch-up frames after a stall. Live socket grace is ${PLAYER_MOTION.reconnectGraceMs / 1000} seconds; after the socket is gone, Enter Game returns you to the same ship for ${PLAYER_MOTION.returnToShipMs / 1000} seconds. Join records the client and server releases that issued the resume token and last wrote the score, plus the server times of those writes. Server-only score writes omit a client release.`,
      ],
    },
  ],
  teamwork: [
    {
      heading: 'Shared field values',
      paragraphs: [
        `World radius is ${WORLD.radius.toLocaleString('en-US')} units with ${WORLD.sectorSize.toLocaleString('en-US')}-unit sectors. Passive exploration ranges are Surveyor ${EXPLORATION_RANGE.surveyor} and Hauler ${EXPLORATION_RANGE.hauler} world units. Active Surveyor scans reach ${SHIP_ABILITY.SCAN_RANGE}; explored cells persist and are shared by every pilot. Player cruise uses speed scale ${GAME.PLAYER_SPEED_SCALE}. A visited, fully mapped, empty sector is walled off.`,
        `${starterFurnaces.map((furnace) => `${furnace.name} (${furnace.radius}-unit intake)`).join(', ')} anchor the starter area; ${FURNACES.length - starterFurnaces.length} regional Works sites are distributed across the field. Every Hauler and recorded Surveyor receives the full size-scaled material reward; size-25 base values are ice ${furnaceReward({ material: 'ice', size: 25 })}, metal ${furnaceReward({ material: 'metal', size: 25 })}, and rubble ${furnaceReward({ material: 'rubble', size: 25 })}.`,
      ],
    },
  ],
};
