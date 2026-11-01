#!/usr/bin/env node
async function main(): Promise<void> {
  const { default: process } = await import('node:process');
  const fs = await import('node:fs');
  const destination = process.env['BENCHMARK_RECORDS'];
  if (destination === undefined) {
    throw new Error('Missing BENCHMARK_RECORDS fixture destination');
  }
  const record: { kind: 'build'; args: string[] } = {
    kind: 'build',
    args: process.argv.slice(2),
  };
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`);
  process.exit(process.env['FAIL_BUILD'] === '1' ? 23 : 0);
}
void main();
