import { once } from 'node:events';
import { createServer } from 'node:http';
import process from 'node:process';
import { readServerConfiguration } from './configuration';
import { SERVER_RELEASE_ID } from './release';

// This entrypoint deliberately imports no gameplay, persistence, backup or report owner.
// Operator commands run separately in the container Console after explicit approval.
const { port } = readServerConfiguration();
const status = {
  status: 'maintenance',
  gameplayAvailable: false,
  worldOpened: false,
  releaseId: SERVER_RELEASE_ID,
};
const body = JSON.stringify(status);
const server = createServer((request, response) => {
  const readiness =
    (request.method === 'GET' || request.method === 'HEAD') && request.url === '/health';
  response.writeHead(readiness ? 200 : 503, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(body);
});
server.on('upgrade', (_request, socket) => {
  socket.end(
    'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    () => socket.destroy()
  );
});

const listening = once(server, 'listening');
server.listen(port);
await listening;
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('World maintenance requires a TCP listener');
}
let stopping = false;
function stop(): void {
  if (stopping) {
    return;
  }
  stopping = true;
  server.close();
  server.closeAllConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdout.write(
  `${JSON.stringify({ event: 'world_maintenance_ready', port: address.port, ...status })}\n`
);
