import type { Page, WebSocket } from 'playwright';
import type { FurnaceDelivery, PlayerShotAcknowledgement, Position } from '../../../shared-types';

function position(value: unknown): value is Position {
  return (
    value !== null &&
    typeof value === 'object' &&
    'x' in value &&
    'y' in value &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y)
  );
}

/** Observe only combat and reward metadata. Never retain joins, URLs, or credentials. */
export function watchCrewMessages(page: Page) {
  const shots: { requestId: string; start: Position; velocity: Position }[] = [];
  const acknowledgements: PlayerShotAcknowledgement[] = [];
  const deliveries: Pick<FurnaceDelivery, 'asteroidId' | 'furnaceId' | 'rewards'>[] = [];
  const failures: string[] = [];
  let dropped = 0;
  const retain = <T>(rows: T[], row: T) => {
    if (rows.length >= 32) {
      dropped++;
      return;
    }
    rows.push(row);
  };
  const cleanups: (() => void)[] = [];
  const read = (payload: string | Buffer, direction: 'sent' | 'received') => {
    try {
      const message: unknown = JSON.parse(
        typeof payload === 'string' ? payload : payload.toString()
      );
      if (!message || typeof message !== 'object' || !('type' in message) || !('data' in message)) {
        return;
      }
      const data = message.data;
      if (!data || typeof data !== 'object') {
        return;
      }
      if (direction === 'sent' && message.type === 'shoot') {
        if (
          !('requestId' in data) ||
          typeof data.requestId !== 'string' ||
          !('laserStart' in data) ||
          !position(data.laserStart) ||
          !('laserDirection' in data) ||
          !position(data.laserDirection)
        ) {
          throw new Error('Shot omitted its correlated launch');
        }
        retain(shots, {
          requestId: data.requestId,
          start: data.laserStart,
          velocity: data.laserDirection,
        });
      }
      if (direction === 'received' && message.type === 'shotAcknowledged') {
        if (
          !('requestId' in data) ||
          typeof data.requestId !== 'string' ||
          !('projectileId' in data) ||
          (data.projectileId !== null && typeof data.projectileId !== 'string')
        ) {
          throw new Error('Invalid shot receipt');
        }
        retain(acknowledgements, { requestId: data.requestId, projectileId: data.projectileId });
      }
      if (direction === 'received' && message.type === 'furnaceDelivery') {
        if (
          !('asteroidId' in data) ||
          typeof data.asteroidId !== 'string' ||
          !('furnaceId' in data) ||
          typeof data.furnaceId !== 'string' ||
          !('rewards' in data) ||
          !Array.isArray(data.rewards)
        ) {
          throw new Error('Invalid delivery receipt');
        }
        const rewards = data.rewards.map((row: unknown) => {
          if (
            !row ||
            typeof row !== 'object' ||
            !('playerId' in row) ||
            typeof row.playerId !== 'string' ||
            !('playerName' in row) ||
            typeof row.playerName !== 'string' ||
            !('points' in row) ||
            typeof row.points !== 'number' ||
            !('score' in row) ||
            typeof row.score !== 'number'
          ) {
            throw new Error('Invalid delivery reward');
          }
          return {
            playerId: row.playerId,
            playerName: row.playerName,
            points: row.points,
            score: row.score,
          };
        });
        retain(deliveries, { asteroidId: data.asteroidId, furnaceId: data.furnaceId, rewards });
      }
    } catch (error) {
      retain(failures, error instanceof Error ? error.message : String(error));
    }
  };
  const connected = (socket: WebSocket) => {
    const sent = ({ payload }: { payload: string | Buffer }) => read(payload, 'sent');
    const received = ({ payload }: { payload: string | Buffer }) => read(payload, 'received');
    socket.on('framesent', sent);
    socket.on('framereceived', received);
    cleanups.push(() => {
      socket.off('framesent', sent);
      socket.off('framereceived', received);
    });
  };
  page.on('websocket', connected);
  return {
    shots,
    acknowledgements,
    deliveries,
    failures,
    snapshot: () => structuredClone({ shots, acknowledgements, deliveries, failures, dropped }),
    stop: () => {
      page.off('websocket', connected);
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
