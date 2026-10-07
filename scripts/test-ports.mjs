import { createServer } from 'node:net';
import process from 'node:process';

// Hold all automatic choices together until the caller can start its services.
// A later bind race still fails closed: runners never attach to an existing pair.
const selected = process.argv.slice(2);
if (selected.length !== 3) {
  throw new Error('Expected Vite, game-server and proxy port selections');
}
const explicit = selected.filter(Boolean).map(Number);
if (
  explicit.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
  new Set(explicit).size !== explicit.length
) {
  throw new Error('Test ports must be valid and distinct');
}
const reservations = [];
try {
  for (let index = 0; index < selected.length; index++) {
    if (selected[index]) {
      continue;
    }
    let reservation;
    do {
      const server = createServer();
      await new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing owned port reservation');
      }
      reservation = { server, port: address.port };
      if (explicit.includes(reservation.port)) {
        await new Promise((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept()))
        );
      }
    } while (explicit.includes(reservation.port));
    reservations.push(reservation.server);
    selected[index] = String(reservation.port);
  }
  process.stdout.write(`${selected.join('\n')}\n`);
} finally {
  await Promise.all(
    reservations.map(
      (server) =>
        new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept())))
    )
  );
}
