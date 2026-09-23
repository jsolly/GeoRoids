import { ASTEROID_BELT, beltSlots } from '../../shared/asteroidBelt';
import { asteroidShardMass } from '../../shared/asteroidMaterials';
import { ASTEROID_INTERACTIONS } from '../../shared/asteroidPhenomena';
import { colossalMiningHealth } from '../../shared/asteroidScale';
import { BELT_CRAWLER } from '../../shared/beltCrawler';
import {
  calculateHealthRegenDelayFrames,
  calculateHealthRegenPerFrame,
} from '../../shared/constants/health';
import { ECONOMY, settlementRecipe } from '../../shared/economy';
import { SATELLITE_PROFILES } from '../../shared/eoSatellites';
import { EXPLORATION_RANGE } from '../../shared/exploration';
import { FURNACE_BUILD } from '../../shared/furnaceField';
import {
  CIVIC_LOTS,
  FURNACE_PIPE_SPEED,
  furnaceReward,
  TOWN_HEARTH,
  TOWN_SPAWN_RADIUS,
} from '../../shared/furnaces';
import { MAX_CATCH_UP_TICKS } from '../../shared/gameClock';
import { LOOT_BLAST } from '../../shared/lootBlast';
import { PLAYER_MOTION } from '../../shared/playerMotion';
import { BOOST } from '../../shared/shipBoost';
import { GROWTH } from '../../shared/shipGrowth';
import { SURVEY_PROBE } from '../../shared/surveyProbe';
import { SPIDER } from '../../shared/terrainSpider';
import { WORLD } from '../../shared/world';
import type { ShipKitId } from '../../shared-types';
import { DAMAGE, GAME, LASER, ROID, SATELLITE_PICKUP, SHIP, SHOCKWAVE } from '../constants';
import { getShipKit, SHIP_ABILITY, SHIP_KIT_IDS } from '../entities/ship/shipKits';
import { getGameBoundary } from '../physics/boundary';
import { TERRAIN } from '../physics/terrain/terrainConfig';

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

function furnaceLots(ring: 1 | 2 | 3) {
  return CIVIC_LOTS.filter((lot) => lot.ring === ring);
}

function furnaceCost(ring: 1 | 2 | 3): string {
  return (furnaceLots(ring)[0]?.cost ?? 0).toLocaleString('en-US');
}

export const gameReference: Record<string, { heading: string; paragraphs: string[] }[]> = {
  'field-manual': [
    {
      heading: 'Current values',
      paragraphs: [
        `Players respawn indefinitely. Points start banked at ${GAME.STARTING_SCORE}; collected points must be hauled to a furnace. Ship kits: ${SHIP_KIT_IDS.length} (${SHIP_KIT_IDS.map((id) => getShipKit(id).name).join(', ')}).`,
        `Earth-observation pickup hulls: ${SATELLITE_PROFILES.length}.`,
        `${TOWN_HEARTH.name} is the only pre-lit hearth. ${CIVIC_LOTS.length} furnace foundations start dark: ${furnaceLots(1).length} at score ${furnaceCost(1)}, ${furnaceLots(2).length} at score ${furnaceCost(2)}, and ${furnaceLots(3).length} at score ${furnaceCost(3)}.`,
        `Death drops carried points for anyone to recover for ${ECONOMY.deathLootFrames / GAME.FPS} seconds. Banked points persist. A disconnect shorter than ${PLAYER_MOTION.returnToShipMs / 1000} seconds returns you to the same ship; longer gaps preserve cargo and bank.`,
      ],
    },
  ],
  controls: [
    {
      heading: 'Movement values',
      paragraphs: [
        `Automatic movement defaults: thrust ${SHIP.THRUST}, maximum velocity ${SHIP.MAX_VELOCITY}, and turn rate ${SHIP.TURN_SPEED} degrees per second. Terrain and mass still affect flight. The simulation runs at ${GAME.FPS} frames per second.`,
        `Shift, right-click, or the Boost button multiplies cruise speed and thrust by ${getShipKit('scout').boostMultiplier} for Scout and ${getShipKit('hauler').boostMultiplier} for Hauler. Tap, click, or press again to return to the shared cruise speed. A full tank lasts ${BOOST.durationMs / 1000} seconds and refills from empty in ${BOOST.rechargeMs / 1000} seconds; any available charge can start another burst and interrupt recharging.`,
        `Movement and projectiles are ${Math.round((1 - GAME.MOTION_SCALE) * 100)}% slower. Turning, firing cadence, and ability cooldowns keep their responsiveness. Shots still reach the same distance, but take longer to get there.`,
      ],
    },
    {
      heading: 'Town store values',
      paragraphs: [
        `E or the ability button inside any lit furnace’s visible footprint opens Furnace travel. B toggles the same menu. The approach prompt shows Press E to travel, or Tap TRAVEL to open map on touch screens. Select another lit furnace on the destination map for a free rocket ride along the pipe network, lasting 0.6–2 seconds. Boarding releases towed cargo and couplings; the ship is protected and cannot act during the ride. The menu holds the ship like the map and schematic. Town Square offers level-gated placeholder purchases that spend banked points with no gameplay effect.`,
      ],
    },
  ],
  scout: [
    {
      heading: 'Furnace construction',
      paragraphs: [
        `Near a dark furnace lot within ${FURNACE_BUILD.APPROACH} units, E becomes Build instead of Mineral Scan or Survey Probe. Build spends the Scout's own score to light the ${FURNACE_BUILD.RADIUS}-unit furnace foundation under the ship. The inward lot on that pipeline must already be burning, and that pilot's score must cover the lot (${furnaceCost(1)}, ${furnaceCost(2)}, or ${furnaceCost(3)}). Building works during tool cooldown and inside a nest. Lighting immediately breaks hunts within the ${SPIDER.FURNACE_SAFE_RADIUS}-unit safe area and sends living spiders fleeing; covered nest guards become roamers. The lit furnace keeps the builder's name. Success spends that cost without resetting the current tool cooldown. Lit furnaces persist until the world resets. ${TOWN_HEARTH.name} stays lit.`,
      ],
    },
    {
      heading: 'Scout values',
      paragraphs: [shipStats('scout')],
    },
    {
      heading: 'Ability and exploration values',
      paragraphs: [
        `With Mineral Scan equipped, E runs a ${seconds(SHIP_ABILITY.SCAN_FRAMES)} mineral scan within ${SHIP_ABILITY.SCAN_RANGE} units. While active, a thin cyan radar sweep pulses from the Scout to the viewport edge; this visual cue does not expand the scan range. Spiders inside that range flee and cannot bite while the scan is active. The scan cooldown is ${seconds(SHIP_ABILITY.COOLDOWN_FRAMES.scout)}; each identified rock keeps its classification and records the Scout player ID for a later furnace delivery.`,
        `Survey Probe: launch range ${SURVEY_PROBE.LAUNCH_RANGE} units; beacon scan radius ${SURVEY_PROBE.RANGE} units every ${SURVEY_PROBE.PULSE_MS / 1000} seconds; battery ${SURVEY_PROBE.LIFETIME_MS / 60000} minutes with a warning during the last ${SURVEY_PROBE.WARNING_MS / 1000} seconds. Health: ${SURVEY_PROBE.MAX_HEALTH}. Maximum ${SURVEY_PROBE.MAX_PER_OWNER} active probes per Scout; a successful extra attachment replaces the oldest. Attachment cooldown: ${seconds(SURVEY_PROBE.COOLDOWN_FRAMES)}.`,
        `Passive shared exploration reaches ${EXPLORATION_RANGE.scout} world units for Scout and ${EXPLORATION_RANGE.hauler} for Hauler; revealed cells persist for the match.`,
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
        `Hauler lasers deal ${SHIP_ABILITY.ASTEROID_DAMAGE_MULTIPLIER} times normal mining damage to metal asteroids, cooperative large rocks, and colossal deposits. The ability has no ship-targeting mode.`,
        `E attaches the equipped Hauler utility within a fixed ${SHIP_ABILITY.HARPOON_RANGE}-unit hull gap. Resource Tap ejects ${SHIP_ABILITY.TAP_EXTRACT_BURSTS} canisters over ${seconds(SHIP_ABILITY.TAP_EXTRACT_FRAMES)} and leaves the rock intact. Tow Cable keeps the rock's velocity and corrects only when stretched; a successful attachment starts the ${seconds(SHIP_ABILITY.COOLDOWN_FRAMES.hauler)} cooldown, while E again releases the tether immediately. Ordinary towed cargo that overlaps another asteroid or another ship uses the ordinary collision break and detaches the cable. A colossal deposit needs ${ROID.COLOSSAL_CREW} Tow Cables before it will haul, and ${ROID.COLOSSAL_CREW} Boost Couplings before ignition; ramming it or dragging it into another rock does not shatter it.`,
        `Furnace intakes are ${TOWN_HEARTH.radius} units. At size 25, delivery rewards are ice ${furnaceReward({ id: 'reference', ore: 'ice', material: 'ice', size: 25 })}, metal ${furnaceReward({ id: 'reference', ore: 'metal', material: 'metal', size: 25 })}, and rubble ${furnaceReward({ id: 'reference', ore: 'rubble', material: 'rubble', size: 25 })} points for the Hauler and each recorded Scout. A lit furnace shows a right-angle fire trail from its grate through each inward lot on its parent chain to ${TOWN_HEARTH.name}. A delivery sends a brighter head along that trail at ${FURNACE_PIPE_SPEED.toLocaleString('en-US')} world units per second.`,
      ],
    },
  ],
  'loot-growth': [
    {
      heading: 'Growth and loot values',
      paragraphs: [
        `Growth starts at mass ${GROWTH.BASE_MASS}, soft-caps at ${GROWTH.SOFT_MAX_MASS}, scales health up to ${GROWTH.MAX_HEALTH_SCALE}× the Scout base, and bottoms out at thrust scale ${GROWTH.MIN_THRUST_SCALE} and speed scale ${GROWTH.MIN_SPEED_SCALE}. Hull size stays at the kit base. An environmental ship death always contributes at least ${GROWTH.BASE_KILL_MASS} mass, converts ${GROWTH.DROP_FRACTION * 100}% of excess mass, targets ${GROWTH.PELLET_MASS} mass per pellet, allows at most ${GROWTH.MAX_PELLETS} pellets, and caps live loot at ${GROWTH.MAX_LOOT}. Loot lasts ${seconds(GROWTH.LOOT_TTL_FRAMES)}.`,
        `Wreckage and shard drops have radius ${GROWTH.LOOT_RADIUS}. Tap canisters have radius ${GROWTH.TAP_LOOT_RADIUS}, mass ${GROWTH.TAP_LOOT_MASS}, and score ${GROWTH.TAP_LOOT_SCORE}. A living ship magnetizes ordinary drops within ${GROWTH.LOOT_MAGNET_RANGE} units with acceleration ${GROWTH.LOOT_MAGNET_ACCEL}. Tap loot uses range ${GROWTH.TAP_LOOT_MAGNET_RANGE} and acceleration ${GROWTH.TAP_LOOT_MAGNET_ACCEL} toward a Hauler. Pickup overlap uses each kit's hull radius plus the drop radius.`,
        `Shard score: ${GROWTH.SHARD_SCORE}. Reflected shots can reach a maximum laser energy of ${ASTEROID_INTERACTIONS.maxLaserEnergy}.`,
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
      heading: 'Belt recovery and crawler values',
      paragraphs: [
        `The eastern belt contains ${beltSlots().length} metal deposits around ${ASTEROID_BELT.radius.toLocaleString('en-US')} world units from launch. Destroying a deposit or moving it more than ${ASTEROID_BELT.removalDistance} units from home starts a ${ASTEROID_BELT.recoveryMs / 60000}-minute replacement timer. The final ${ASTEROID_BELT.warningMs / 1000} seconds show the reformation warning.`,
        `A belt crawler has ${BELT_CRAWLER.MAX_HEALTH} health. Its lunge extends ${BELT_CRAWLER.LUNGE_REACH} units after ${frameValue(BELT_CRAWLER.WINDUP_FRAMES)} of warning, then takes ${frameValue(BELT_CRAWLER.RECOVERY_FRAMES)} to recover. Pursuit hops and destroyed-host escapes take ${frameValue(BELT_CRAWLER.ESCAPE_FRAMES)} to reach a clear rock surface within ${BELT_CRAWLER.ESCAPE_DISTANCE} units.`,
        'Belt crawlers cannot be tapped, probed, towed directly or repelled by Mineral Scan. They cannot attack during a hop; towing their host carries them along.',
      ],
    },
    {
      heading: 'Field and material values',
      paragraphs: [
        `The procedural field uses ${WORLD.sectorSize.toLocaleString('en-US')}-unit sectors with ${WORLD.depositsPerSector} deterministic deposits per sector inside the ${WORLD.radius.toLocaleString('en-US')}-unit world. Fresh interior sectors have ${Math.round(WORLD.depositsPerSector * ROID.STATIONARY_FRACTION)} stationary deposits and ${WORLD.depositsPerSector - Math.round(WORLD.depositsPerSector * ROID.STATIONARY_FRACTION)} drifting deposits. Drift speeds range from ${(ROID.DRIFT_SPEED_MIN * GAME.FPS).toFixed(1)} to ${(ROID.DRIFT_SPEED_MAX * GAME.FPS).toFixed(1)} world units per second. Ice, rubble, and crystal have ${DAMAGE.LASER_HIT} health; metal has ${DAMAGE.LASER_HIT * 3}. A colossal deposit is size ${ROID.COLOSSAL_SIZE} with ${colossalMiningHealth()} mining health. Metal shard mass is ${asteroidShardMass('metal')}; ice and rubble shard mass is ${asteroidShardMass('ice')}.`,
      ],
    },
    {
      heading: 'Split and score values',
      paragraphs: [
        `The fast collaboration shockwave reaches ${SHOCKWAVE.FAST.radius} units with impulse ${SHOCKWAVE.FAST.impulse}; the heavy wave reaches ${SHOCKWAVE.HEAVY.radius} units with impulse ${SHOCKWAVE.HEAVY.impulse}.`,
        `Large-rock collaboration starts at size ${ROID.COLLAB_SPLIT_MIN_SIZE}; the collaboration window is ${ROID.COLLAB_SPLIT_WINDOW_MS} milliseconds and same-shooter deduplication lasts ${ROID.COLLAB_HIT_DEDUPE_MS} milliseconds. Colossal deposits begin at size ${ROID.COLOSSAL_MIN_SIZE}, need ${ROID.COLOSSAL_CREW} Haulers or Boost Couplings, take ${ROID.COLOSSAL_LASER_HITS} Scout laser hits, and appear in 1 of every ${ROID.COLOSSAL_SECTOR_PERIOD} sectors outside the ${ROID.COLOSSAL_CORE_EXCLUSION * 2 - 1}×${ROID.COLOSSAL_CORE_EXCLUSION * 2 - 1} launch neighborhood. Asteroid point drops are colossal ${ROID.POINTS_COLOSSAL}, large ${ROID.POINTS_LARGE}, medium ${ROID.POINTS_MEDIUM}, and small ${ROID.POINTS_SMALL}.`,
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
        `Shared hardware maximum: ${SATELLITE_PICKUP.MAX_COUNT}; spawn ring: ${SATELLITE_PICKUP.SPAWN_RING_MIN}–${SATELLITE_PICKUP.SPAWN_RING_MAX}; carried point bonus: ${SATELLITE_PICKUP.SCORE_BONUS}; automatic collection range: ${SATELLITE_PICKUP.AUTO_COLLECT_RANGE}; health: ${SATELLITE_PICKUP.HEALTH}; minimum owner orbit radius: ${SATELLITE_PICKUP.ORBIT_RADIUS}; hull gap: ${SATELLITE_PICKUP.ORBIT_GAP}; scan range: ${SATELLITE_PICKUP.SCAN_RANGE}; full-health lifetime without damage: ${frameValue(SATELLITE_PICKUP.LIFETIME_FRAMES)}; broken or exhausted pickup respawn: ${frameValue(SATELLITE_PICKUP.RESPAWN_FRAMES)}.`,
      ],
    },
  ],
  terrain: [
    {
      heading: 'Terrain travel values',
      paragraphs: [
        `At full steepness, climbing speed is ${TERRAIN.CLIMB_SPEED_FRACTION * 100}% of normal cruise and descending speed is ${(1 + TERRAIN.DESCENT_SPEED_BONUS) * 100}% of normal cruise. Cross-slope downhill drift reaches ${TERRAIN.CROSS_SLOPE_DRIFT * 100}% of cruise. Kit, mass, and Boost scale all three together.`,
      ],
    },
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
        `A ship can have ${SHIP.MAX_LASERS} local lasers. Laser projectiles use hit radius ${LASER.HIT_RADIUS}; a normal laser hit deals ${DAMAGE.LASER_HIT}. Unbounced ship lasers, ship-to-ship ramming, tow cables, and shot-triggered loot blasts leave crew hulls unharmed. After a bounce, a laser deals ${DAMAGE.LASER_HIT} times its energy to any live ship it hits, including its owner, and is consumed. An environmental asteroid impact deals ${DAMAGE.ASTEROID_COLLISION}; a towed ordinary rock uses that same impact against another ship and then breaks. A colossal deposit deals that impact without shattering. Boundary contact destroys a vulnerable ship regardless of hull health.`,
        `Spawn protection lasts ${frameValue(SHIP.INVINCIBILITY_DURATION_FRAMES)}.`,
      ],
    },
    {
      heading: 'Lifecycle and health values',
      paragraphs: [
        `Explosion duration is ${frameValue(SHIP.EXPLODE_DURATION_FRAMES)}; respawn delay is ${frameValue(SHIP.RESPAWN_DELAY_FRAMES)}. Players always respawn at the nearest lit hearth with a ${TOWN_SPAWN_RADIUS}-unit offset. Carried points drop on death and expire after ${ECONOMY.deathLootFrames / GAME.FPS} seconds; banked points survive.`,
        `Health regeneration is ${SHIP.HEALTH_REGEN_RATE} point per second (${calculateHealthRegenPerFrame()} per frame) after a ${SHIP.HEALTH_REGEN_DELAY} second delay (${calculateHealthRegenDelayFrames()} frames).`,
      ],
    },
    {
      heading: 'Score values',
      paragraphs: [
        `Carried asteroid points: colossal ${ROID.POINTS_COLOSSAL}, large ${ROID.POINTS_LARGE}, medium ${ROID.POINTS_MEDIUM}, small ${ROID.POINTS_SMALL}. Shard score: ${GROWTH.SHARD_SCORE}. Satellite pickup score: ${SATELLITE_PICKUP.SCORE_BONUS}. Furnace delivery at size 25 awards ice ${furnaceReward({ id: 'reference', ore: 'ice', material: 'ice', size: 25 })}, metal ${furnaceReward({ id: 'reference', ore: 'metal', material: 'metal', size: 25 })}, or rubble ${furnaceReward({ id: 'reference', ore: 'rubble', material: 'rubble', size: 25 })} to each contributor.`,
      ],
    },
  ],
  'hud-network': [
    {
      heading: 'Display and HUD values',
      paragraphs: [
        `The shared simulation runs at ${GAME.FPS} frames per second. The local minimap uses a ${WORLD.minimapRadius}-unit radar radius. Lit hearths appear there after the crew reveals them; dark furnace foundations inside that radar stay marked. Fire trails appear on that radar and on the full-screen universe map only after a furnace is lit, and they turn at right angles back to ${TOWN_HEARTH.name}. The universe map also shows the shared exploration chart and other discovered assets across the ${WORLD.radius.toLocaleString('en-US')}-unit world. M or the on-screen Map button opens the overview; M, Escape, or Close returns to flight. Touch chrome hides those keyboard badges. Ships on the local minimap and universe map use each pilot's hull silhouette.`,
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
        `World radius is ${WORLD.radius.toLocaleString('en-US')} units with ${WORLD.sectorSize.toLocaleString('en-US')}-unit sectors. Passive exploration ranges are Scout ${EXPLORATION_RANGE.scout} and Hauler ${EXPLORATION_RANGE.hauler} world units. Active Scout scans reach ${SHIP_ABILITY.SCAN_RANGE}; explored cells persist and are shared by every pilot. Player cruise uses speed scale ${GAME.PLAYER_SPEED_SCALE}. A visited region with no asteroids left stays empty, and ships can still fly through it.`,
        `Cargo capacity: Scout ${ECONOMY.scoutCapacity}, Hauler ${ECONOMY.haulerCapacity}. The next settlement tier costs the current level times ${settlementRecipe(1).points} banked deliveries, ${settlementRecipe(1).resources.ice} ice, ${settlementRecipe(1).resources.metal} metal, ${settlementRecipe(1).resources.rubble} rubble, and ${settlementRecipe(1).resources.crystal} crystal. All five requirements must be met; surplus carries forward.`,
        `${TOWN_HEARTH.name} (${TOWN_HEARTH.radius}-unit intake) is the only pre-lit hearth. ${furnaceLots(1).length} furnace lots sit in the first band, then ${furnaceLots(2).length} and ${furnaceLots(3).length} farther lots scattered through outer bands. A Scout builds the next dark foundation with their own score once its inward parent lot is burning and that score covers ${furnaceCost(1)}, ${furnaceCost(2)}, or ${furnaceCost(3)}. The furnace keeps the builder's name. Every Hauler and recorded Scout receives the size-scaled material reward. Size-25 base values are ice ${furnaceReward({ id: 'reference', ore: 'ice', material: 'ice', size: 25 })}, metal ${furnaceReward({ id: 'reference', ore: 'metal', material: 'metal', size: 25 })}, and rubble ${furnaceReward({ id: 'reference', ore: 'rubble', material: 'rubble', size: 25 })}. The Town Square store sells level-gated placeholders with no gameplay effect.`,
      ],
    },
  ],
};
