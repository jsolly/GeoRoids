import process from 'node:process';
import { runProductionHealthWatch } from './production-health-watch.ts';

try {
  const result = await runProductionHealthWatch({ token: process.env['GITHUB_TOKEN'] ?? '' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  console.error(
    'Production health watch failed; inspect GitHub API availability and workflow permissions'
  );
  process.exitCode = 1;
}
