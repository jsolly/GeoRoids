import process from 'node:process';
export function readServerConfiguration(env: NodeJS.ProcessEnv = process.env): {
  port: number;
  nodeEnv: string;
  localPlayground: boolean;
} {
  const rawPort = env['PORT'];
  const port = rawPort === undefined || rawPort === '' ? 3001 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const nodeEnv = env['NODE_ENV'] || 'production';
  return {
    port,
    nodeEnv,
    localPlayground: nodeEnv === 'development' && env['GEOROIDS_LOCAL_PLAYGROUND'] === '1',
  };
}
