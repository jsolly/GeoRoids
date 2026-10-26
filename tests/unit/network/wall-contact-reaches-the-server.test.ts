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

    // One frame of outward flight puts the hull in contact.
    local.ship.position = { ...OVERLAPPING };
    CollisionManager.getInstance().checkBoundaryCollisions([local.ship]);
    expect(local.ship.health).toBeGreaterThan(0);
    expect(local.ship.exploding).toBe(false);

    manager.sendPlayerState({ id: manager.getLocalPlayerId(), ...local.getStateForNetwork() });

    const packet = ws.sent.at(-1);
    expect(packet?.type).toBe('update');
    const reported = packet?.data?.['position'] as { x: number; y: number } | undefined;
    expect(reported).toEqual(OVERLAPPING);
    expect(checkBoundaryCollision(reported ?? LAST_ACCEPTED, HULL_RADIUS)).toBe(true);
    expect(typeof packet?.data?.['motionEpoch']).toBe('number');
  });
});
