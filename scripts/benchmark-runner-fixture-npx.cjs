#!/usr/bin/env node
// Generated from benchmark-runner-fixture-npx.cts by generate-asset-boundaries.ts; do not edit.
async function main() {
  const { default: process } = await import('node:process');
  const fs = await import('node:fs');
  const destination = process.env['BENCHMARK_RECORDS'];
  if (destination === undefined) {
    throw new Error('Missing BENCHMARK_RECORDS fixture destination');
  }
  const recordsPath = destination;
  function append(event) {
    fs.appendFileSync(recordsPath, `${JSON.stringify(event)}\n`);
  }
  const args = process.argv.slice(2);
  const services = args.includes('concurrently');
  append({ kind: services ? 'services' : 'measurement', pid: process.pid, args });
  if (services) {
    fs.writeFileSync(`${destination}.pid`, String(process.pid));
    process.on('SIGTERM', () => {
      append({ kind: 'services-closed', pid: process.pid });
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  } else {
    process.exit(0);
  }
}
void main();
