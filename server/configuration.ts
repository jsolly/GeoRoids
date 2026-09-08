export function readServerConfiguration(env: NodeJS.ProcessEnv = process.env): {
  port: number;
  nodeEnv: string;
  requireEnhancedClient: boolean;
} {
  const rawPort = env['PORT'];
  const port = rawPort === undefined || rawPort === '' ? 3001 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return {
    port,
    nodeEnv: env['NODE_ENV'] || 'production',
    requireEnhancedClient: env['REQUIRE_ASTEROID_CLIENT'] === '1',
  };
}
