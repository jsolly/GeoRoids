import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Rerun the control contract without launching a browser or a game service.
const result = spawnSync(
  'npm',
  [
    'run',
    'test',
    '--',
    'tests/unit/entities/tap-destinations-stop-on-arrival.test.ts',
    'tests/unit/input/mobile-pilots-command-travel-and-combat.test.ts',
    'tests/unit/input/visible-objects-offer-actions-before-contact.test.ts',
    'tests/unit/server/player-shield-protects-without-resetting-cooldown.test.ts',
  ],
  { stdio: 'inherit', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } }
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
