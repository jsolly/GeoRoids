import { SATELLITE_PROFILES } from '../../../shared/eoSatellites';
import type { AsteroidMaterial, ServerGameSnapshot, ShipKitId } from '../../../shared-types';

export function snapshotFixture(tick = 0): ServerGameSnapshot {
  const kits: ShipKitId[] = ['dart', 'hauler', 'warden', 'skirmisher', 'quake'];
  const materials: AsteroidMaterial[] = ['ice', 'metal', 'rubble'];
  return {
    entities: Array.from({ length: 10 }, (_, i) => {
      const kitId = kits[i % kits.length];
      if (!kitId) {
        throw new Error('Snapshot fixture requires a ship kit');
      }
      return {
        id: `pilot-${i}`,
        name: `Pilot ${i}`,
        type: i < 5 ? 'human' : 'bot',
        position: { x: 500 + i * 90 + tick * 0.7, y: 100 + i * 30 + tick * 0.4 },
        velocity: { x: 0.7, y: 0.4 },
        angle: i + tick * 0.01,
        exploding: false,
        thrusting: true,
        color: '#89aaff',
        lives: 3,
        score: 10,
        health: 100,
        maxHealth: 100,
        fuel: 50,
        maxFuel: 100,
        mass: 4,
        kitId,
        factionId: i % 2 ? 'ion' : 'ember',
        abilityCooldownFrames: 0,
        abilityActiveFrames: 0,
        shieldTimer: 0,
        harpoonTimer: 0,
        shieldActive: false,
        shieldTime: 0,
        shieldCooldown: 0,
        shieldFlashTime: 0,
      };
    }),
    asteroids: Array.from({ length: 80 }, (_, i) => {
      const material = materials[i % materials.length];
      if (!material) {
        throw new Error('Snapshot fixture requires an asteroid material');
      }
      return {
        id: `asteroid-${i}`,
        position: { x: i * 80 + tick * 0.1, y: i * 30 - tick * 0.2 },
        velocity: { x: 0.1, y: -0.2 },
        size: 20 + (i % 3) * 15,
        jaggedness: 0.4,
        rotation: tick * 0.002,
        angularVelocity: 0.002,
        health: 50,
        maxHealth: 50,
        vertices: 12,
        offsets: [1, 0.9, 0.8, 1.1, 0.9, 1.2, 1, 0.8, 1.1, 0.95, 0.9, 1],
        isCollabTarget: i === 0,
        material,
      };
    }),
    loot: Array.from({ length: 15 }, (_, i) => ({
      id: `loot-${i}`,
      position: { x: i * 50, y: 600 },
      mass: 1,
      radius: 5,
      kind: i % 2 ? 'fuel' : 'shard',
      ...(i % 2 ? { fuel: 20 } : {}),
    })),
    satellites: SATELLITE_PROFILES.map((profile, i) => ({
      id: `eo-${i}`,
      name: profile.displayName,
      typeId: profile.typeId,
      assetKey: profile.assetKey,
      shotManner: profile.shotManner,
      position: { x: i * 120 + tick * 0.2, y: 900 },
      velocity: { x: 0.2, y: 0 },
      angle: tick * 0.02,
      exploding: false,
      color: profile.hullColor,
      health: 50,
      maxHealth: 50,
      radius: 16,
    })),
    satellitePickups: (['echo', 'relay'] as const).map((typeId, i) => ({
      id: `pickup-${i}`,
      name: typeId === 'echo' ? 'Echo' : 'Relay',
      typeId,
      assetKey: `pickup/${typeId}`,
      position: { x: 300 + i * 150, y: 550 + tick * 0.1 },
      velocity: { x: 0, y: 0.1 },
      angle: tick * 0.08,
      radius: 9,
      color: '#FBBF24',
      state: tick < 60 ? 'orbiting' : 'loose',
      ownerId: tick < 60 ? 'pilot-0' : null,
      shieldFramesRemaining: tick < 60 ? 60 - tick : 0,
    })),
    satelliteProjectiles:
      tick % 120 < 90
        ? SATELLITE_PROFILES.map((_, i) => ({
            id: `shot-${Math.floor(tick / 120)}-${i}`,
            shotId: `shot-${Math.floor(tick / 120)}-${i}`,
            satelliteId: `eo-${i}`,
            position: { x: i * 120 + (tick % 120) * 5, y: 920 },
            velocity: { x: 5, y: 0 },
            age: tick % 120,
          }))
        : [],
    collabTags:
      tick < 40
        ? [
            {
              id: 'asteroid-0',
              asteroidId: 'asteroid-0',
              hits: [{ shooterId: 'pilot-0', at: 1000 + tick * 33, points: 20 }],
              expiresAt: 5000,
            },
          ]
        : [],
    gameTime: tick / 30,
    isPaused: false,
    terrainSeed: 2345,
  };
}
