export type ClientLogContext = {
  sessionId: string;
  playerId?: string;
  connectionId?: string;
};

const sessionId =
  globalThis.crypto?.randomUUID?.() ??
  `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let identity: Omit<ClientLogContext, 'sessionId'> = {};

/** Replace the current connection identity; the page session always remains stable. */
export function setClientLogContext(context: { playerId?: string; connectionId?: string }): void {
  identity = {
    ...(context.playerId ? { playerId: context.playerId } : {}),
    ...(context.connectionId ? { connectionId: context.connectionId } : {}),
  };
}

export function getClientLogContext(): ClientLogContext {
  return { sessionId, ...identity };
}
