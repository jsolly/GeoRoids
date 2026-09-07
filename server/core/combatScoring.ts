import type { GameEntity } from './EntityManager';

/** Kill scores match the previous handlePlayerDamage / handleBotDamage literals. */
export const KILL_SCORE = {
  human: 200,
  bot: 50,
} as const;

export function shouldAwardHumanKillPoints(
  attackerId: string,
  targetId: string,
  attackerExists: boolean
): boolean {
  return Boolean(attackerId) && attackerId !== targetId && attackerExists;
}

export function killScoreFor(type: GameEntity['type']): number {
  return type === 'bot' ? KILL_SCORE.bot : KILL_SCORE.human;
}
