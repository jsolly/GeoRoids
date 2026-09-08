#!/usr/bin/env tsx

import { HealthChecker } from '../tests/integration/utils/health-checker';

async function main() {
  try {
    console.log('🔍 Checking server health...\n');
    await HealthChecker.checkAllServers();
    console.log('\n🎯 All servers are healthy and ready for testing!');
    process.exit(0);
  } catch (error) {
    console.error(
      '\n❌ Server health check failed:',
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main();
