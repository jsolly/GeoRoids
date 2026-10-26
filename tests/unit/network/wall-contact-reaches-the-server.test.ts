import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkBoundaryCollision } from '../../../shared/boundary';
import { hullRadiusForKit } from '../../../shared/shipKits';
import {
  captureSnapshot,
  SNAPSHOT_VERSION,
  SnapshotEncoder,
} from '../../../shared/snapshotProtocol';
import { WORLD } from '../../../shared/world';
import { PlayerManager } from '../../../src/entities/player/PlayerManager';
import { ConnectionManager } from '../../../src/network/services/ConnectionManager';
import { CollisionManager } from '../../../src/physics/CollisionManager';
import { snapshotFixture } from './snapshotFixture';

/** Transport seam only: the packet still crosses the production sender,
 * `buildHandoffPose` and `getStateForNetwork`. */
class Transport {
  static OPEN = 1;
  static CONNECTING = 0;
  static latest: Transport;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Array<{ type: string; id?: string; data?: Record<string, unknown> }> = [];
  constructor() {
    Transport.latest = this;
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  receive(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, timestamp: 1 }) });
  }
}

const HULL_RADIUS = hullRadiusForKit('scout');
/** `floor(59_985) + 15` lands exactly on the wall: the last legal position. */
const LAST_ACCEPTED = { x: WORLD.radius - HULL_RADIUS, y: 0 };
/** One ordinary step further out, which the wall rule counts as contact. */
const OVERLAPPING = { x: WORLD.radius - HULL_RADIUS + 1, y: 0 };

beforeAll(() => {
  const network = ConnectionManager.getInstance();
  PlayerManager.getInstance({ networkPort: network, combatNetwork: network.combatNetwork });
});

describe('wall contact reaches the server', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', Transport);
    manager = ConnectionManager.getInstance();
    manager.disconnect();
  });

  afterEach(() => {
    manager.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('the hull radius and world size this arrangement relies on', () => {
    expect(HULL_RADIUS).toBe(15);
    expect(WORLD.radius).toBe(60_000);
  });

  test('the overlapping position a hull reports is what leaves the socket', async () => {
    // The server owns wall death and can only read it from the position this
    // packet carries, so nothing between the collision check and the socket may
    // clamp, suppress or round that position back inside the wall.
    expect(checkBoundaryCollision(LAST_ACCEPTED, HULL_RADIUS)).toBe(false);
    expect(checkBoundaryCollision(OVERLAPPING, HULL_RADIUS)).toBe(true);

    const local = PlayerManager.getInstance().createLocalPlayer('scout');
    local.ship.position = { ...LAST_ACCEPTED };
    local.ship.blinkCount = 0;

    const pending = manager.connect();
    const ws = Transport.latest;
    ws.onopen?.();
    await pending;
    manager.setLocalPlayerName('Rim pilot');
    ws.receive('joined', {
      id: manager.getClientId(),
      name: 'Rim pilot',
      position: { ...LAST_ACCEPTED },
      color: '#fff',
      snapshotVersion: SNAPSHOT_VERSION,
      asteroidInteractions: 1,
      terrainSeed: 7,
      resumeToken: 'a'.repeat(64),
    });

    // Authoritative pose: the last position the server accepted, inside the wall.
    const state = captureSnapshot(snapshotFixture());
    const row = state.entities[0];
    if (!row) {
      throw new Error('Local pose fixture unavailable');
    }
    row.id = local.id;
    row.position = { ...LAST_ACCEPTED };
    row.velocity = { x: 0, y: 0 };
    row.playerMotion = { epoch: 1, mode: 'free', ack: 0 };
    ws.receive('snapshot', new SnapshotEncoder(state).encode(1));

    // Fly there with the real integration rather than placing the hull. The
    // design rests on a live hull carrying itself from the last accepted
    // position to an overlapping one, so a clamp or a speed limit that stopped
    // outward travel at the rim would retire the lethal rule silently.
    local.ship.angle = 0;
    local.ship.thrusting = true;
    let frames = 0;
    while (!checkBoundaryCollision(local.ship.position, local.ship.r) && frames < 30) {
      local.ship.update();
      frames += 1;
    }
    expect(checkBoundaryCollision(local.ship.position, local.ship.r)).toBe(true);
    const flownTo = { ...local.ship.position };

    CollisionManager.getInstance().checkBoundaryCollisions([local.ship]);
    expect(local.ship.health).toBeGreaterThan(0);
    expect(local.ship.exploding).toBe(false);

    // Report through the production chain that `GameController` actually calls —
    // `updateNetworkState` → `updatePlayerState` → `sendPlayerState` — rather
    // than the sender alone. The latch that decides whether a contact run has
    // been reported is set from this boolean, so a hop that returns `true`
    // without sending would re-latch the run on a report that never left and
    // retire the lethal rule for any contact lasting a single frame.
    expect(PlayerManager.getInstance().updateNetworkState()).toBe(true);

    const packet = ws.sent.at(-1);
    expect(packet?.type).toBe('update');
    const reported = packet?.data?.['position'] as { x: number; y: number } | undefined;
    expect(reported).toEqual(flownTo);
    expect(checkBoundaryCollision(reported ?? LAST_ACCEPTED, HULL_RADIUS)).toBe(true);
    // `getStateForNetwork` ships `ship.position` by reference, so the position
    // assertions above hold even for an undecorated packet. These two are what
    // prove the production pose allocator ran and did not refuse the
    // overlapping pose; do not drop them as redundant.
    expect(typeof packet?.data?.['motionEpoch']).toBe('number');
    expect(typeof packet?.data?.['motionSequence']).toBe('number');

    // And the other direction: a pose the socket cannot carry must say so, so
    // the caller retries instead of believing the contact was reported. Each of
    // these refusals sends nothing, and the latch reads the boolean rather than
    // the attempt, so each has to answer `false` for the retry to happen.
    const delivered = ws.sent.length;

    // Furnace transit: the hull is not flying its own pose.
    local.ship.furnaceTransit = {
      sourceId: 'furnace-a',
      destinationId: 'furnace-b',
      startedAt: Date.now(),
      durationMs: 1000,
    };
    expect(PlayerManager.getInstance().updateNetworkState()).toBe(false);
    local.ship.furnaceTransit = null;

    // Closed socket.
    ws.readyState = 3;
    expect(PlayerManager.getInstance().updateNetworkState()).toBe(false);
    expect(ws.sent).toHaveLength(delivered);
  });
});
