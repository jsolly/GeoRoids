// Client and server deploy independently. Preserve the HTTP readiness and
// behavior budgets while verifying the deployed HTTP and gameplay protocols.
import process from 'node:process';
import { runNetworkSmoke } from './production-smoke-network.mjs';
import { productionUrl, smoke } from './production-smoke-scenario.mjs';

try {
  const receipt = await runNetworkSmoke({ scenario: { productionUrl, smoke } });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.success) {
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('Production verification could not retain its receipt\n');
  process.exitCode = 1;
}
