#!/usr/bin/env node
// Generated from benchmark-runner-fixture-npm.cts by generate-asset-boundaries.ts; do not edit.
async function main() {
  const { default: process } = await import('node:process');
  const fs = await import('node:fs');
  const destination = process.env['BENCHMARK_RECORDS'];
  if (destination === undefined) {
    throw new Error('Missing BENCHMARK_RECORDS fixture destination');
  }
  const record = {
    kind: 'build',
    args: process.argv.slice(2),
  };
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`);
  process.exit(process.env['FAIL_BUILD'] === '1' ? 23 : 0);
}
void main();
