// Client and server deploy independently. Preserve the HTTP readiness and
// behavior budgets while verifying the deployed HTTP and gameplay protocols.
import process from 'node:process';
import { runNetworkSmoke } from './production-smoke-network.mts';
import { productionUrl, smoke } from './production-smoke-scenario.mts';

try {
  const receipt = await runNetworkSmoke({ scenario: { productionUrl, smoke } });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!receipt.success) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Production verification could not retain its receipt', error);
  process.exitCode = 1;
}
