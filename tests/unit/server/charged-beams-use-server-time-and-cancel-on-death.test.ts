/* @vitest-environment node */
import { expect, test } from 'vitest';
import { MessageHandler } from '../../../server/communication/MessageHandler';
import { GameEngine } from '../../../server/core/GameEngine';
import { ServerClock } from '../../../server/core/ServerClock';
import { GameStateBroadcaster } from '../../../server/services/GameStateBroadcaster';
import { CHARGED_WEAPON } from '../../../shared/chargedWeapon';
import { GAME, LASER, SHIP } from '../../../shared/constants/gameplay';
import { civicLot } from '../../../shared/furnaces';
import { getShipKit } from '../../../shared/shipKits';
import { RecordingSocket } from '../../support/recordingSocket';

function scenario() {
  let now = 0;
  const engine = new GameEngine(
    123,
    new ServerClock({ wallNow: () => 1000, monotonicNow: () => now })
  );
  const socket = new RecordingSocket();
  const pilot = engine.addPlayer('pilot', 'Pilot', socket, { x: 0, y: 0 });
  pilot.position = { x: 0, y: 0 };
  pilot.spawnProtectionTimer = 0;
  const advance = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      engine.advanceCombatFrame();
    }
  };
  return {
    engine,
    pilot,
    socket,
    advance,
    elapse: (ms: number) => {
      now += ms;
    },
  };
}

test('one active frame cancels a held charge before an overlay is closed again', () => {
  const { engine, pilot, advance } = scenario();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.fullFrames);
  pilot.overlayHold = true;
  engine.advanceOneFrame();
  pilot.overlayHold = false;
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  expect(engine.getServerLasers()).toHaveLength(0);
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.minimumFrames);
  expect(engine.chargedWeapons.request(pilot.id, 'release')?.charged).toBe(true);
});

test('a charge is cancelled before a furnace arrival clears its transit hold in the same frame', () => {
  const { engine, pilot, advance } = scenario();
  const street = civicLot('street-1-0');
  if (!street) {
    throw new Error('Expected the first furnace site');
  }
  pilot.position = { ...street.position };
  pilot.score = street.cost;
  expect(engine.useAbility(pilot.id)).toBe(true);
  pilot.position = { x: 0, y: 0 };
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.fullFrames);
  expect(engine.travelFurnace(pilot.id, street.id)).toBeUndefined();
  const transit = pilot.furnaceTransit;
  if (!transit) {
    throw new Error('Expected an admitted furnace trip');
  }
  transit.durationMs = 1;
  engine.advanceOneFrame();
  expect(pilot.furnaceTransit).toBeNull();
  expect(pilot.overlayHold).toBe(false);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  expect(engine.getServerLasers()).toHaveLength(0);
});

test('rejected charged release obeys ordinary firing budget without consuming its charge cooldown', () => {
  const { engine, pilot, advance, elapse } = scenario();
  const origin = { x: 20, y: 0 };
  const velocity = { x: LASER.SPEED / GAME.FPS, y: 0 };
  for (let i = 0; i < SHIP.MAX_LASERS; i++) {
    expect(engine.spawnPlayerLaser(pilot.id, origin, velocity)).not.toBeNull();
  }
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.minimumFrames);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  expect(engine.getServerLasers()).toHaveLength(SHIP.MAX_LASERS);

  elapse(getShipKit(pilot.kitId).shotCooldown);
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.minimumFrames);
  const accepted = engine.chargedWeapons.request(pilot.id, 'release');
  expect(accepted?.charged).toBe(true);
  expect(accepted?.ownerId).toBe(pilot.id);
  expect(engine.getServerLasers()).toHaveLength(SHIP.MAX_LASERS + 1);
});

test('diagnostic world arrangement preserves a live charge while a full reset admits a fresh life', () => {
  const { engine, pilot, advance } = scenario();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.fullFrames);
  engine.prepareDiagnosticWorld('traversal');
  expect(engine.chargedWeapons.request(pilot.id, 'release')?.energy).toBe(
    CHARGED_WEAPON.maximumEnergy
  );
  engine.resetForTesting();
  const replacement = engine.addPlayer(pilot.id, 'Fresh pilot', new RecordingSocket(), {
    x: 0,
    y: 0,
  });
  replacement.spawnProtectionTimer = 0;
  expect(engine.chargedWeapons.request(replacement.id, 'release')).toBeNull();
  engine.chargedWeapons.request(replacement.id, 'start');
  advance(CHARGED_WEAPON.minimumFrames);
  expect(engine.chargedWeapons.request(replacement.id, 'release')?.charged).toBe(true);
});

test('a charge abandoned during transport loss cannot block the resumed pilot from firing', () => {
  const { engine, pilot, socket, advance } = scenario();
  const registration = engine.registerPilot(pilot, socket);
  if (!registration.ok) {
    throw new Error(registration.error);
  }
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(60);
  expect(engine.transportClosed(socket)).toBe(true);
  expect(engine.resumePilot(registration.resumeToken, new RecordingSocket()).ok).toBe(true);
  expect(
    engine.getSnapshotState().entities.find((row) => row.id === pilot.id)?.weaponChargeFrames
  ).toBe(0);
  expect(
    engine.spawnPlayerLaser(pilot.id, { x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 })
  ).not.toBeNull();
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
});

test('a replacement socket cancels abandoned charge while repeated joins on the owning socket preserve it', () => {
  const { engine, pilot, socket, advance } = scenario();
  const registration = engine.registerPilot(pilot, socket);
  if (!registration.ok) {
    throw new Error(registration.error);
  }
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(60);
  expect(engine.resumePilot(registration.resumeToken, socket).ok).toBe(true);
  expect(
    engine.getSnapshotState().entities.find((row) => row.id === pilot.id)?.weaponChargeFrames
  ).toBe(61);
  const replacement = new RecordingSocket();
  const resumed = engine.resumePilot(registration.resumeToken, replacement);
  expect(resumed.ok).toBe(true);
  expect(engine.transportClosed(socket)).toBe(false);
  expect(
    engine.getSnapshotState().entities.find((row) => row.id === pilot.id)?.weaponChargeFrames
  ).toBe(0);
  expect(
    engine.spawnPlayerLaser(pilot.id, { x: 20, y: 0 }, { x: LASER.SPEED / GAME.FPS, y: 0 })
  ).not.toBeNull();
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
});

test('charge releases one bounded stronger projectile using elapsed server frames and enforces cooldown', () => {
  const partial = scenario();
  partial.engine.chargedWeapons.request(partial.pilot.id, 'start');
  partial.advance(45);
  const partialShot = partial.engine.chargedWeapons.request(partial.pilot.id, 'release');
  expect(partialShot?.energy).toBe(2.5);
  expect(partialShot?.miningDamage).toBe(62.5);

  const { engine, pilot, advance } = scenario();
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(1);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(45);
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(45);
  const shot = engine.chargedWeapons.request(pilot.id, 'release');
  expect(shot?.energy).toBe(CHARGED_WEAPON.maximumEnergy);
  expect(shot?.miningDamage).toBe(100);
  expect(engine.getPlayerProjectiles()[0]?.energy).toBe(4);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(90);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  advance(CHARGED_WEAPON.cooldownFrames);
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(180);
  expect(engine.chargedWeapons.request(pilot.id, 'release')?.energy).toBe(4);
});

test('cancellation, overlays, expiry and a dead life cannot release a stored charge', () => {
  const { engine, pilot, advance } = scenario();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(90);
  engine.chargedWeapons.request(pilot.id, 'cancel');
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(90);
  pilot.overlayHold = true;
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  pilot.overlayHold = false;
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(CHARGED_WEAPON.expiryFrames + 1);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(90);
  engine.handleShipDamage(pilot.id, 'boundary', 1000);
  advance(90);
  expect(pilot.health).toBeGreaterThan(0);
  expect(engine.chargedWeapons.request(pilot.id, 'release')).toBeNull();
});

test('wire clients cannot forge charge time or act for a different socket owner', () => {
  const { engine, pilot, socket, advance } = scenario();
  const handler = new MessageHandler(engine, new GameStateBroadcaster(engine));
  const send = (id: string, action: string) =>
    handler.handleMessage(
      { type: 'chargeWeapon', id, data: { action, chargeFrames: 999999 } },
      socket
    );
  send('stranger', 'start');
  advance(90);
  send(pilot.id, 'release');
  expect(engine.getServerLasers()).toHaveLength(0);
  send(pilot.id, 'start');
  send(pilot.id, 'release');
  expect(engine.getServerLasers()).toHaveLength(0);
  send(pilot.id, 'start');
  advance(90);
  send(pilot.id, 'release');
  expect(engine.getServerLasers()).toHaveLength(1);
  expect(engine.getServerLasers()[0]?.energy).toBe(4);
});

test('a full beam applies exactly four ordinary mining hits of damage once to a durable deposit', () => {
  const { engine, pilot, advance } = scenario();
  for (const rock of engine.getAllAsteroids()) {
    engine.removeAsteroid(rock.id);
  }
  engine.addAsteroid({
    id: 'durable-target',
    position: { x: 100, y: 0 },
    velocity: { x: 0, y: 0 },
    size: 30,
    health: 500,
    maxHealth: 500,
    material: 'metal',
    rotation: 0,
    angularVelocity: 0,
    vertices: 4,
    offsets: [1, 1, 1, 1],
    jaggedness: 0,
  });
  pilot.angle = 0;
  engine.chargedWeapons.request(pilot.id, 'start');
  advance(90);
  const shot = engine.chargedWeapons.request(pilot.id, 'release');
  expect(shot).not.toBeNull();
  for (let i = 0; i < 20; i++) {
    engine.advanceLasersAndResolveHits();
  }
  expect(engine.getAsteroid('durable-target')?.health).toBe(400);
});
