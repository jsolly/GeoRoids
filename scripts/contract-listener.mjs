import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import process from 'node:process';

const readyPath = process.argv[2];
if (!readyPath) {
  throw new Error('A private readiness file path is required');
}

// Keep the occupied socket bound while allocating the distinct, unused server
// port. Only the occupied socket remains reserved after readiness is published.
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const occupiedPort = listener.address().port;
const serverPort = reservation.address().port;
reservation.close();
await once(reservation, 'close');

writeFileSync(`${readyPath}.tmp`, `${process.pid} ${occupiedPort} ${serverPort}\n`);
renameSync(`${readyPath}.tmp`, readyPath);
