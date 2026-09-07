import { describe, expect, test } from 'vitest';
import { DAMAGE, ROID } from '../../../src/constants';
import {
  asteroidDestroyedMessage,
  laserHitDamageMessage,
} from '../../../src/physics/collision/combatMessages';

describe('shared combat network messages', () => {
  test('laser hits send botDamage or laserDamage for bot, remote, and local hulls', () => {
    expect(laserHitDamageMessage({ id: 'server-bot-0', type: 'bot' }, 'p1')).toEqual({
      type: 'botDamage',
      data: { botId: 'server-bot-0', attackerId: 'p1', damage: DAMAGE.LASER_HIT },
    });
    expect(laserHitDamageMessage({ id: 'p2', type: 'remote' }, 'p1')).toEqual({
      type: 'laserDamage',
      data: { targetPlayerId: 'p2', attackerId: 'p1', damage: DAMAGE.LASER_HIT },
    });
    expect(laserHitDamageMessage({ id: 'p1', type: 'local' }, 'server-bot-0')).toEqual({
      type: 'laserDamage',
      data: { targetPlayerId: 'p1', attackerId: 'server-bot-0', damage: DAMAGE.LASER_HIT },
    });
  });

  test('asteroidDestroyed points use the shared size buckets', () => {
    expect(asteroidDestroyedMessage('roid-1', 'p1', 40)).toEqual({
      type: 'asteroidDestroyed',
      data: { asteroidId: 'roid-1', playerId: 'p1', points: ROID.POINTS_LARGE, cause: 'laser' },
    });
    expect(asteroidDestroyedMessage('roid-1', 'p1', 20).data).toMatchObject({
      points: ROID.POINTS_MEDIUM,
    });
    expect(asteroidDestroyedMessage('roid-1', 'p1', 10).data).toMatchObject({
      points: ROID.POINTS_SMALL,
    });
  });
});
