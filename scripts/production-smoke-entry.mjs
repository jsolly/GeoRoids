// GeoRoids hosts deploy independently: reserve two minutes for client propagation,
// then retain the canonical runner's browser diagnostics and authoritative gameplay checks.
import process from 'node:process';
import { runSmoke } from './production-smoke.mjs';
import { productionUrl, smoke } from './production-smoke-scenario.mjs';

try {
  const receipt = await runSmoke({ scenario: { productionUrl, smoke }, behaviorMs: 240000 });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.success) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error}\n`);
  process.exitCode = 1;
}
