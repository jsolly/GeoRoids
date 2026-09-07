export type PlayerKind = 'local' | 'remote' | 'bot';

export type Combatant = {
  id: string;
  type: PlayerKind;
};

export function isBot(player: { type: PlayerKind }): boolean {
  return player.type === 'bot';
}

export function isRemote(player: { type: PlayerKind }): boolean {
  return player.type === 'remote';
}

export function isLocal(player: { type: PlayerKind }): boolean {
  return player.type === 'local';
}

/** Server-authored bots use a stable id prefix on both client and server. */
