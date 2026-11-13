import process from 'node:process';
import type { WorldOpenIntent } from './world/worldPersistence';

/** The single Railway environment allowed to serve the built client from the game server. */
const PREVIEW_ENVIRONMENT = 'preview';

export function readServerConfiguration(env: NodeJS.ProcessEnv = process.env): {
  port: number;
  nodeEnv: string;
  localPlayground: boolean;
  previewClient: boolean;
  worldOpenIntent: WorldOpenIntent;
} {
  const rawPort = env['PORT'];
  const port = rawPort === undefined || rawPort === '' ? 3001 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const nodeEnv = env['NODE_ENV'] || 'production';
  const previewClient = env['GEOROIDS_PREVIEW_CLIENT'] === '1';
  // Fail closed: a preview flag copied into any other environment stops startup,
  // so the healthcheck fails and Railway keeps the previous deployment.
  if (previewClient && env['RAILWAY_ENVIRONMENT_NAME'] !== PREVIEW_ENVIRONMENT) {
    throw new Error(
      `GEOROIDS_PREVIEW_CLIENT requires RAILWAY_ENVIRONMENT_NAME=${PREVIEW_ENVIRONMENT}`
    );
  }
  return {
    port,
    nodeEnv,
    // A preview world is shared with whoever opens the URL, so it never gets the playground preset.
    localPlayground:
      !previewClient && nodeEnv === 'development' && env['GEOROIDS_LOCAL_PLAYGROUND'] === '1',
    previewClient,
    worldOpenIntent:
      previewClient || nodeEnv === 'development' || nodeEnv === 'test' ? 'private' : 'existing',
  };
}
